import React, { useCallback, useEffect, useRef, useState } from "react"
import { matchPath, useLocation, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { CalculatorContext } from "./CalculatorContext"
import { clearAuthToken, getAuthToken } from "./authToken"
import type {
	CalculatorData,
	UserStats,
	ClubRank,
	TeamTrialsRank,
	ChampionsMeetingRank,
	LeagueOfHeroesRank,
	UserPlannedBanner,
	BannerUma,
	BannerSupport,
	BannerStepUp,
	GameEvent,
	ChampionsMeeting,
	LeagueOfHeroes,
	OrganizedTimelineData,
	AnniversaryEvent,
	Scenario,
	UserPlannedPurchase,
	UserStepUpSelection,
	IncomeLedgerRow,
	Plan,
	PlanWithRows,
	CalculationConstants
} from "../types"
import { DEFAULT_CONSTANTS } from "../constants/gameConstants"
import {
	initialCalculatorDataFetch,
	userCalculatorDataPatch,
	toBannerPayload,
	toPurchasePayload,
	toStepUpSelectionPayload
} from "./calculatorFetchCalls"
import {
	DEFAULT_GUEST_STATS,
	readGuestPlanStash,
	clearGuestPlanStash,
	mergeStepUpSelections
} from "./guestMigration"
import {
	planActivate,
	planCreate,
	planDelete,
	planFetch,
	planSetSeparateIncome,
	planRename
} from "./planFetchCalls"
import { useAutoSave } from "../hooks/useAutoSave"

interface CalculatorProviderProps {
	children: React.ReactNode
}

export const CalculatorProvider = ({ children }: CalculatorProviderProps) => {
	const location = useLocation()
	const navigate = useNavigate()
	const navigateToPlan = useCallback(
		(plan: Plan | undefined, replace = false): void => {
			if (!plan?.public_id) return
			const path = `/app/${encodeURIComponent(plan.public_id)}`
			if (location.pathname !== path) navigate(path, { replace })
		},
		[location.pathname, navigate]
	)

	/**
	 * TYPESCRIPT CONCEPT: useState Generic Parameter
	 *
	 * useState<UserStats | null>(null) tells TypeScript the state can be
	 * either a UserStats object or null. Without the generic, TypeScript
	 * would infer the type from the initial value alone — useState(null)
	 * would be typed as `null` forever, and you couldn't set it to UserStats later.
	 *
	 * For arrays, useState<ClubRank[]>([]) works because TypeScript can't infer
	 * the element type from an empty array — [] would become `never[]`.
	 *
	 * NOTE: We no longer use `ClubRank[] | []` — an empty ClubRank[] already
	 * covers the empty case. The `| []` was redundant and added noise.
	 */
	const [userStatsData, setUserStatsData] = useState<UserStats | null>(null)
	const [clubRankData, setClubRankData] = useState<ClubRank[]>([])
	const [teamTrialsRankData, setTeamTrialsRankData] = useState<TeamTrialsRank[]>([])
	const [championsMeetingRankData, setChampionsMeetingRankData] = useState<ChampionsMeetingRank[]>([])
	const [leagueOfHeroesRankData, setLeagueOfHeroesRankData] = useState<LeagueOfHeroesRank[]>([])
	const [umaBannerData, setUmaBannerData] = useState<BannerUma[]>([])
	const [supportBannerData, setSupportBannerData] = useState<BannerSupport[]>([])
	const [stepUpBannerData, setStepUpBannerData] = useState<BannerStepUp[]>([])
	const [userPlannedBannerData, setUserPlannedBannerData] = useState<UserPlannedBanner[]>([])
	// The account's plans, and which one userPlannedBannerData belongs to. A
	// guest keeps [] and null: one unnamed plan in memory, no switcher.
	// activePlanId and userPlannedBannerData are ALWAYS set in the same tick
	// (applyPlan below), so a save can never pair one plan's id with another
	// plan's rows.
	const [plans, setPlans] = useState<Plan[]>([])
	const [activePlanId, setActivePlanId] = useState<number | null>(null)
	const [isPlanBusy, setIsPlanBusy] = useState(false)
	// Deliberately NOT persisted — not to localStorage, not to sessionStorage,
	// and never PATCHed. Staging is scratch space, and a reload clearing it is
	// correct rather than a bug to fix.
	//
	// The reason is that persisting it would make scratch rows outlive the real
	// plan. A guest's CONFIRMED banners are in-memory only and a refresh discards
	// them by design (frontend/docs/state-and-guest-mode.md), so a staged row
	// surviving a reload that wiped the calculator underneath it would be
	// incoherent — the provisional half of the screen would be the durable half.
	//
	// The impermanence is stated in the UI instead: see the hint under the
	// "Staging" heading in CaratCalculator.
	const [stagedBanners, setStagedBanners] = useState<UserPlannedBanner[]>([])
	const [gameEventsData, setGameEventsData] = useState<GameEvent[]>([])
	const [championsMeetingData, setChampionsMeetingData] = useState<ChampionsMeeting[]>([])
	const [leagueOfHeroesData, setLeagueOfHeroesData] = useState<LeagueOfHeroes[]>([])
	const [anniversaryEventData, setAnniversaryEventData] = useState<AnniversaryEvent[]>([])
	const [scenarioData, setScenarioData] = useState<Scenario[]>([])
	const [userPlannedPurchaseData, setUserPlannedPurchaseData] = useState<UserPlannedPurchase[]>([])
	const [userStepUpSelectionData, setUserStepUpSelectionData] = useState<UserStepUpSelection[]>([])
	const [organizedTimelineData, setOrganizedTimelineData] = useState<OrganizedTimelineData>([])
	const [incomeLedger, setIncomeLedger] = useState<IncomeLedgerRow[]>([])
	const [calculationConstants, setCalculationConstants] =
		useState<CalculationConstants>(DEFAULT_CONSTANTS)
	const [isLoading, setIsLoading] = useState(true)
	const [fetchError, setFetchError] = useState(false)

	// The response→request shape conversion lives in toBannerPayload (a pure
	// function) so the guest-migration flow can also run it on data that
	// isn't in React state yet.
	const prepareBannerData = useCallback(
		() => toBannerPayload(userPlannedBannerData),
		[userPlannedBannerData]
	)

	const preparePurchaseData = useCallback(
		() => toPurchasePayload(userPlannedPurchaseData),
		[userPlannedPurchaseData]
	)

	const prepareStepUpSelectionData = useCallback(
		() => toStepUpSelectionPayload(userStepUpSelectionData),
		[userStepUpSelectionData]
	)

	// Whether the most recent performSave landed. useAutoSave's saveFn returns
	// nothing, so the plan actions read the outcome here after `await saveNow()`
	// to decide whether it is safe to replace the rows on screen.
	const lastSaveOkRef = useRef(true)

	const performSave = useCallback(async (): Promise<void> => {
		// Guests never PATCH — their plan is in-memory only. The auto-save
		// timer is already gated, but saveNow could still land here.
		if (!getAuthToken()) return
		try {
			const response = await userCalculatorDataPatch(
					// The plan these rows were loaded from. It comes from the same
					// render as the rows beside it, so the pair is always consistent
					// even if the timer fires mid-switch. See userCalculatorDataPatch.
					activePlanId,
					userStatsData,
					prepareBannerData(),
					preparePurchaseData(),
					prepareStepUpSelectionData()
				)
			lastSaveOkRef.current = response.ok
			if (!response.ok) {
				toast.error("Save failed. Your changes may not have been saved.")
			} else {
				toast.success("Saved")
			}
		} catch {
			lastSaveOkRef.current = false
			toast.error("Save failed. Check your connection.")
		}
	}, [activePlanId, userStatsData, prepareBannerData, preparePurchaseData,
		prepareStepUpSelectionData])

	const { timerIsGoing, startTimer, saveNow, cancelTimer } = useAutoSave({
		saveFn: performSave,
		delayMs: 5000
	})

	// Guards the guest-plan migration against firing twice when React
	// StrictMode double-runs the mount effect in dev.
	const didMigrateRef = useRef(false)

	useEffect(() => {
		const controller = new AbortController()

		const applyData = (data: CalculatorData): void => {
				/**
				 * TYPESCRIPT CONCEPT: Extending Objects with Extra Fields
				 *
				 * We add `_source` to each event for sorting purposes.
				 * By defining these as inline objects with `as const` on the _source
				 * value, TypeScript infers the literal types "banner" | "champions"
				 * rather than just `string`. This helps with type narrowing later.
				 */
				const mergedEvents = [
					...data.banner_timeline_data.map((event) => ({
						...event,
						_source: "banner" as const
					})),
					...data.champions_meeting_data.map((event) => ({
						...event,
						_source: "champions" as const
					})),
					...data.league_of_heroes_event_data.map((event) => ({
						...event,
						_source: "leagueofheroes" as const
					}))
				]

				const sortedMergedEvents = mergedEvents.sort((a, b) => {
					const timeDiff =
						new Date(a.start_date).getTime() -
						new Date(b.start_date).getTime()

					if (timeDiff !== 0) return timeDiff

					if (a._source === "champions" && b._source === "banner") return -1
					if (a._source === "banner" && b._source === "champions") return 1

					return 0
				})

				// Guests get null stats from the server — seed local defaults so
				// downstream components never have to care who they're rendering for.
				setUserStatsData(data.user_stats_data ?? DEFAULT_GUEST_STATS)
				// These three rank types climb monotonically with income, so
				// sorting by income descending puts the best rank first — the
				// natural dropdown order.
				setClubRankData([...data.club_rank_data].sort((a, b) => b.income_amount - a.income_amount))
				setTeamTrialsRankData([...data.team_trials_rank_data].sort((a, b) => b.income_amount - a.income_amount))
				setLeagueOfHeroesRankData([...data.league_of_heroes_rank_data].sort((a, b) => b.income_amount - a.income_amount))
				// Champions Meeting placements DON'T sort logically by income (a
				// top-league Third pays fewer carats than a Group B 1st), so the
				// backend orders them by an explicit sort_order field. Trust that
				// order as-is rather than re-sorting here.
				setChampionsMeetingRankData(data.champions_meeting_rank_data)
				setUmaBannerData(data.banner_uma_data)
				setSupportBannerData(data.banner_support_data)
				// ?? [] because an older API predates this key — the same tolerance
				// calculation_constants gets. A missing catalogue must not blank the page.
				setStepUpBannerData(data.banner_step_up_data ?? [])
				setUserPlannedBannerData(data.user_planned_banner_data)
				// Defaulted: an API from before plans existed sends neither key.
				// [] and null is also the guest value, and it hides the switcher,
				// which is the right way to degrade. Saves then omit plan_id and
				// the server falls back to the account's only plan.
				setPlans(data.user_plans ?? [])
				setActivePlanId(data.active_plan_id ?? null)
				// Defaulted, unlike the keys above, because these two arrived later
				// than the rest of the payload. A backend running a build from
				// before the selector planner omits them entirely, and an
				// undefined here reaches useBannerResources' flatMap and takes
				// down /app and /app/selectors together. Degrade to "no campaigns
				// planned" instead — the rest of the calculator is still correct
				// without them.
				setAnniversaryEventData(data.anniversary_event_data ?? [])
				// Defaulted for the same reason as the campaign keys above: this
				// arrived later than the rest of the payload, so a backend build
				// that predates it must degrade to "no scenarios" rather than
				// putting undefined where the planner expects an array.
				setScenarioData(data.scenario_data ?? [])
				setUserPlannedPurchaseData(data.user_planned_purchase_data ?? [])
				// Defaulted for the same reason as the two above: an API predating
				// step-up selections omits the key entirely.
				setUserStepUpSelectionData(data.user_step_up_selection_data ?? [])
				setGameEventsData(data.events_data)
				setChampionsMeetingData(data.champions_meeting_data)
				setLeagueOfHeroesData(data.league_of_heroes_event_data)
				// Defaulted like the campaign keys above: an older API (or a
				// deploy where the two sides are briefly out of step) should
				// degrade to an empty projection, not crash the calculator.
				setIncomeLedger(data.income_ledger ?? [])
				// Overlaid rather than replaced: a constant the API doesn't know
				// about yet keeps its built-in default instead of arriving
				// undefined and turning every downstream total into NaN.
				setCalculationConstants({
					...DEFAULT_CONSTANTS,
					...(data.calculation_constants ?? {}),
				})
				setOrganizedTimelineData(sortedMergedEvents)
				setIsLoading(false)
		}

		const load = async (): Promise<void> => {
			// A present-but-invalid token makes the backend 401 even on the
			// now-public GET (DRF authenticates before checking permissions).
			// Drop the stale token and retry as a guest instead of stranding
			// the user on the error screen.
			let response = await initialCalculatorDataFetch(controller.signal)
			if (response.status === 401 && getAuthToken()) {
				clearAuthToken()
				response = await initialCalculatorDataFetch(controller.signal)
			}
			if (!response.ok) {
				throw new Error(`calculator-data fetch failed: ${response.status}`)
			}
			let data = (await response.json()) as CalculatorData

			// Guest-plan migration: a stash in sessionStorage + a token means
			// the user just logged in after building a plan as a guest.
			// This runs BEFORE any state is set, so the auto-save effect
			// (which skips while prevStatsRef is null) can't race it.
			const stash = readGuestPlanStash()
			if (
				stash &&
				getAuthToken() &&
				!didMigrateRef.current
			) {
				didMigrateRef.current = true
				try {
					// Conflict rule: keep the account's saved rows (sending them
					// WITH ids preserves them — the PATCH deletes anything absent)
					// and append the guest's rows (no ids → created). Stats are in
					// the stash only if the guest actually edited them.
					const patchResponse = await userCalculatorDataPatch(
						// The guest's rows join the ACTIVE plan: the account rows being
						// resent beside them are that plan's, so it is the only id this
						// body can be reconciled against.
						data.active_plan_id ?? null,
						stash.stats,
						[
							...toBannerPayload(data.user_planned_banner_data),
							...stash.banners
						],
						[
							// Same defaulting as the setter below — this runs on the
							// raw payload, before the state above is populated.
							...toPurchasePayload(data.user_planned_purchase_data ?? []),
							...(stash.purchases ?? [])
						],
						// The account's own rows must be resent, not just the guest's:
						// the PATCH deletes anything absent from the body, so sending
						// only the stash would wipe selections the account already had.
						// mergeStepUpSelections resolves the overlap per step-up —
						// concatenating would collide on the unique slot index and 400
						// the entire migration.
						mergeStepUpSelections(
							toStepUpSelectionPayload(data.user_step_up_selection_data ?? []),
							stash.stepUpSelections ?? []
						)
					)
					if (patchResponse.ok) {
						clearGuestPlanStash()
						// Re-fetch so the migrated banners come back with real
						// database ids in canonical order.
						const refreshed = await initialCalculatorDataFetch(controller.signal)
						if (refreshed.ok) {
							data = (await refreshed.json()) as CalculatorData
						}
						toast.success("Your guest plan was saved to your account")
					} else if (patchResponse.status < 500) {
						// 4xx — retrying the same payload would fail forever.
						clearGuestPlanStash()
						toast.error("Couldn't import your guest plan. Loaded your saved data instead.")
					} else {
						// 5xx — keep the stash so the next page load retries.
						toast.error("Couldn't import your guest plan right now. It will retry on your next visit.")
					}
				} catch (error: unknown) {
					if (error instanceof Error && error.name === "AbortError") throw error
					// Network failure — keep the stash for a retry on next load.
					toast.error("Couldn't import your guest plan right now. It will retry on your next visit.")
				}
			}

			applyData(data)
		}

		load().catch((error: unknown) => {
			// AbortError is expected when Strict Mode cleanup cancels the first fetch
			if (error instanceof Error && error.name === "AbortError") return
			console.error("Error fetching calculator data:", error)
			setIsLoading(false)
			setFetchError(true)
		})

		return () => controller.abort()
	}, [])

	// prevStatsRef tracks what userStatsData was on the last effect run.
	// When it's null, this is either the initial mount or the initial data load — both should
	// be skipped. Only start the timer once real user edits happen (prevStatsRef is non-null).
	const prevStatsRef = useRef<UserStats | null>(null)
	// Set by applyPlan just before it swaps in another plan's rows. Those rows
	// came FROM the server, so the change they cause below is not an edit and
	// must not arm a save that would PATCH a plan straight back to itself.
	const suppressAutoSaveRef = useRef(false)
	useEffect(() => {
		const wasEmpty = prevStatsRef.current === null
		prevStatsRef.current = userStatsData
		if (wasEmpty) return
		if (suppressAutoSaveRef.current) {
			suppressAutoSaveRef.current = false
			return
		}
		// Guests have nothing to save to the server. Never arming the timer
		// also suppresses the pending-save icon and the beforeunload warning.
		if (!getAuthToken()) return
		startTimer()
		// activePlanId is here so this effect is GUARANTEED to run after
		// applyPlan and clear suppressAutoSaveRef. Every applyPlan changes the id;
		// without it, a flag left set would swallow the user's next real edit.
	}, [startTimer, userStatsData, userPlannedBannerData, userPlannedPurchaseData,
		userStepUpSelectionData, activePlanId])

	// ── Plans ────────────────────────────────────────────────────────────────
	//
	// Every action below follows one rule: SAVE WHAT IS ON SCREEN BEFORE
	// REPLACING IT. The rows in state are the only copy of an unsaved edit, so a
	// switch that swapped them out first would lose up to five seconds of work.
	// If that save fails the action stops and the user stays where they are.

	/** Flush a pending auto-save. False means it failed and nothing should move. */
	const flushPendingSave = useCallback(async (): Promise<boolean> => {
		if (!timerIsGoing) return true
		await saveNow()
		return lastSaveOkRef.current
	}, [timerIsGoing, saveNow])

	/**
	 * Put another plan on screen: its id, its rows, its stats and its purchases
	 * move together. The stats and purchases are the plan's own block's or the
	 * account's, whichever the server sent; an API from before separate
	 * resources sends no stats, and one from before purchases followed the
	 * profile sends no purchases. In either case what is on screen (the
	 * account's) is kept.
	 */
	const applyPlan = useCallback((
		planId: number,
		rows: UserPlannedBanner[],
		stats?: UserStats,
		purchases?: UserPlannedPurchase[]
	): void => {
		suppressAutoSaveRef.current = true
		setActivePlanId(planId)
		setUserPlannedBannerData(rows)
		if (stats) setUserStatsData(stats)
		if (purchases) setUserPlannedPurchaseData(purchases)
		// Staged rows were being composed for the plan just left; carrying them
		// across would let "Add" drop them into a different plan.
		setStagedBanners([])
		setPlans((prev) => prev.map((plan) => ({ ...plan, is_active: plan.id === planId })))
	}, [])

	/**
	 * Shared wrapper: one action at a time, the switcher disabled meanwhile, and
	 * a thrown fetch (offline) reported once instead of in every action.
	 */
	const runPlanAction = useCallback(
		async (action: () => Promise<boolean>): Promise<boolean> => {
			if (isPlanBusy) return false
			setIsPlanBusy(true)
			try {
				return await action()
			} catch {
				toast.error("Couldn't reach the server. Check your connection.")
				return false
			} finally {
				setIsPlanBusy(false)
			}
		},
		[isPlanBusy]
	)

	const switchPlan = useCallback(
		(planId: number): Promise<boolean> =>
			runPlanAction(async () => {
				if (planId === activePlanId) {
					// covers an edge case where the user clicks the active plan while still under the /app base url - updates the url
					navigateToPlan(plans.find((plan) => plan.id === planId))
					return true
				}
				if (!(await flushPendingSave())) {
					toast.error("Your changes didn't save, so we stayed on this plan.")
					return false
				}
				// In parallel: one marks it active for the next visit, the other
				// fetches its rows. Neither depends on the other's answer.
				const [activated, fetched] = await Promise.all([
					planActivate(planId),
					planFetch(planId)
				])
				if (!activated.ok || !fetched.ok) {
					toast.error("Couldn't open that plan. Try again.")
					return false
				}
				const data = (await fetched.json()) as PlanWithRows
				applyPlan(
					planId,
					data.user_planned_banner_data,
					data.user_stats_data,
					data.user_planned_purchase_data
				)
				navigateToPlan(plans.find((plan) => plan.id === planId) ?? data.plan)
				return true
			}),
		[runPlanAction, activePlanId, flushPendingSave, applyPlan, navigateToPlan, plans]
	)

	const lastResolvedPlanPathRef = useRef<string | null>(null)
	useEffect(() => {
		if (isLoading || lastResolvedPlanPathRef.current === location.pathname) return
		lastResolvedPlanPathRef.current = location.pathname
		const publicId = matchPath(
			{ path: "/app/:public_id", end: true },
			location.pathname
		)?.params.public_id
		if (!publicId) return

		const requestedPlan = plans.find((plan) => plan.public_id === publicId)
		if (requestedPlan) {
			if (requestedPlan.id !== activePlanId) void switchPlan(requestedPlan.id)
			return
		}

		const activePlan = plans.find((plan) => plan.id === activePlanId)
		if (activePlan?.public_id) navigateToPlan(activePlan, true)
		else navigate("/app", { replace: true })
	}, [isLoading, location.pathname, plans, activePlanId, switchPlan, navigateToPlan, navigate])

	const createPlan = useCallback(
		(name: string, copyFromId?: number): Promise<boolean> =>
			runPlanAction(async () => {
				// Before the POST, not just before the switch: a copy of the open
				// plan has to include the edit made two seconds ago.
				if (!(await flushPendingSave())) {
					toast.error("Your changes didn't save, so the plan wasn't created.")
					return false
				}
				const created = await planCreate(name, copyFromId)
				if (!created.ok) {
					// The server words the two refusals a person can cause (the cap,
					// a blank name). Anything else gets the generic line.
					const body = (await created.json().catch(() => null)) as
						| { error?: string; name?: string[] }
						| null
					toast.error(body?.error ?? body?.name?.[0] ?? "Couldn't create the plan. Try again.")
					return false
				}
				const data = (await created.json()) as PlanWithRows
				setPlans((prev) => [...prev, data.plan])
				// Created inactive on the server. If this fails the plan still
				// exists and is in the list; the user just is not on it yet.
				const activated = await planActivate(data.plan.id)
				if (!activated.ok) {
					toast.error("The plan was created, but we couldn't open it. Pick it from the list.")
					return false
				}
				applyPlan(
					data.plan.id,
					data.user_planned_banner_data,
					data.user_stats_data,
					data.user_planned_purchase_data
				)
				navigateToPlan(data.plan)
				toast.success(copyFromId === undefined ? "Plan created" : "Plan copied")
				return true
			}),
		[runPlanAction, flushPendingSave, applyPlan, navigateToPlan]
	)

	const renamePlan = useCallback(
		(planId: number, name: string): Promise<boolean> =>
			runPlanAction(async () => {
				const response = await planRename(planId, name)
				if (!response.ok) {
					const body = (await response.json().catch(() => null)) as
						| { name?: string[] }
						| null
					toast.error(body?.name?.[0] ?? "Couldn't rename the plan. Try again.")
					return false
				}
				// Take the server's copy: it collapses runs of spaces in the name.
				const renamed = (await response.json()) as Plan
				setPlans((prev) => prev.map((plan) => (plan.id === planId ? renamed : plan)))
				return true
			}),
		[runPlanAction]
	)

	const deletePlan = useCallback(
		(planId: number): Promise<boolean> =>
			runPlanAction(async () => {
				const deletingOpenPlan = planId === activePlanId
				// A pending save for a DIFFERENT plan's rows is still wanted, so it
				// is flushed. One for the plan being deleted is dropped instead:
				// left alone it would fire at a plan id that no longer exists.
				if (deletingOpenPlan) {
					cancelTimer()
				} else if (!(await flushPendingSave())) {
					toast.error("Your changes didn't save, so the plan wasn't deleted.")
					return false
				}
				const response = await planDelete(planId)
				if (!response.ok) {
					const body = (await response.json().catch(() => null)) as
						| { error?: string }
						| null
					toast.error(body?.error ?? "Couldn't delete the plan. Try again.")
					return false
				}
				const { active_plan_id: landedOn } = (await response.json()) as {
					active_plan_id: number
				}
				const remainingPlans = plans.filter((plan) => plan.id !== planId)
				setPlans(remainingPlans)
				if (deletingOpenPlan) {
					// The server promoted another plan. Its rows are not on screen yet.
					const nextPlan = remainingPlans.find((plan) => plan.id === landedOn) ?? remainingPlans[0]
					const nextPlanId = nextPlan?.id ?? landedOn
					const fetched = await planFetch(nextPlanId)
					if (!fetched.ok) {
						// The delete is done and cannot be undone from here, and the
						// rows on screen belong to nothing. A reload is the honest fix.
						window.location.reload()
						return true
					}
					const data = (await fetched.json()) as PlanWithRows
					applyPlan(
						nextPlanId,
						data.user_planned_banner_data,
						data.user_stats_data,
						data.user_planned_purchase_data
					)
					navigateToPlan(nextPlan ?? data.plan)
				}
				toast.success("Plan deleted")
				return true
			}),
		[runPlanAction, activePlanId, cancelTimer, flushPendingSave, applyPlan, plans, navigateToPlan]
	)

	const setSeparateIncome = useCallback(
		(planId: number, on: boolean): Promise<boolean> =>
			runPlanAction(async () => {
				// Flush FIRST, and not only for the rows: the stats on screen may be
				// an unsaved edit that belongs to the block this plan reads today,
				// and the server seeds the new copy from the database. Without the
				// flush the copy would start from numbers the person no longer sees.
				if (!(await flushPendingSave())) {
					toast.error("Your changes didn't save, so nothing was changed.")
					return false
				}
				const response = await planSetSeparateIncome(planId, on)
				if (!response.ok) {
					toast.error("Couldn't change that. Try again.")
					return false
				}
				const updated = (await response.json()) as Plan
				setPlans((prev) => prev.map((plan) => (plan.id === planId ? updated : plan)))
				// The stats and purchases the plan now reads are not in that
				// answer. Fetch them the way a switch does, so they land through
				// the same code path (and are not mistaken for an edit).
				if (planId === activePlanId) {
					const fetched = await planFetch(planId)
					if (!fetched.ok) {
						toast.error("Changed, but couldn't load the new numbers. Reload the page.")
						return false
					}
					const data = (await fetched.json()) as PlanWithRows
					applyPlan(
						planId,
						data.user_planned_banner_data,
						data.user_stats_data,
						data.user_planned_purchase_data
					)
				}
				toast.success(
					on
						? "This plan now has its own resources."
						: "This plan uses your account's resources again."
				)
				return true
			}),
		[runPlanAction, activePlanId, flushPendingSave, applyPlan]
	)

	const value = {
		userStatsData,
		clubRankData,
		teamTrialsRankData,
		championsMeetingRankData,
		leagueOfHeroesRankData,
		umaBannerData,
		supportBannerData,
		stepUpBannerData,
		userPlannedBannerData,
		stagedBanners,
		anniversaryEventData,
		scenarioData,
		userPlannedPurchaseData,
		userStepUpSelectionData,
		gameEventsData,
		championsMeetingData,
		leagueOfHeroesData,
		incomeLedger,
		calculationConstants,
		timerIsGoing,
		isLoading,
		fetchError,
		organizedTimelineData,
		plans,
		activePlanId,
		isPlanBusy,
		switchPlan,
		createPlan,
		renamePlan,
		deletePlan,
		setSeparateIncome,
		saveNow,
		setUserPlannedBannerData,
		setStagedBanners,
		setUserPlannedPurchaseData,
		setUserStepUpSelectionData,
		setUserStatsData
	}

	// Children render straight away, loading or not.
	//
	// This used to return a bare spinner on an empty page until the fetch
	// landed, which threw away the navbar and footer as well — the whole of
	// /app was blank for as long as the request took. The wait itself is
	// unchanged, but ApplicationViews now paints the shell immediately and
	// gates only the page area, which is where the data is actually needed.
	//
	// The routed pages stay behind that gate: CaratCalculator, Timeline and
	// Selectors are all written assuming their collections are populated, and
	// letting them mount early would mean auditing all three for empty data.
	return (
		<CalculatorContext.Provider value={value}>
			{children}
		</CalculatorContext.Provider>
	)
}