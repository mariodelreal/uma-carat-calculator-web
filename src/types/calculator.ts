/**
 * Aggregate types that combine the domain types into larger structures.
 * These are separated because they depend on everything else — keeping
 * them in their own file prevents circular imports.
 *
 * TYPESCRIPT CONCEPT: Import Types
 * `import type` is a TypeScript-only import that's erased at compile time.
 * It tells the bundler "I only need this for type checking, not at runtime."
 * This prevents accidental circular dependencies and reduces bundle size.
 * Always use `import type` when you're only importing interfaces/types.
 */

import type { Dispatch, SetStateAction } from "react"
import type {
	BannerUma,
	BannerSupport,
	BannerStepUp,
	BannerTimelineForViewing
} from "./banner"
import type {
	ClubRank,
	TeamTrialsRank,
	ChampionsMeetingRank,
	LeagueOfHeroesRank
} from "./ranks"
import type { UserStats, UserPlannedBanner, UserStepUpSelection } from "./user"
import type { GameEvent, ChampionsMeeting, LeagueOfHeroes, RaceEvent } from "./events"
import type { AnniversaryEvent, UserPlannedPurchase } from "./anniversary"
import type { Scenario } from "./scenario"
import type { Plan } from "./plan"
import type { IncomeLedgerRow } from "./ledger"
import type { CalculationConstants } from "./constants"

/** The full payload returned by GET /calculator-data.
 * `user_stats_data` is null for anonymous (guest) requests — the provider
 * seeds DEFAULT_GUEST_STATS in that case. */
export interface CalculatorData {
	user_stats_data: UserStats | null
	club_rank_data: ClubRank[]
	team_trials_rank_data: TeamTrialsRank[]
	champions_meeting_rank_data: ChampionsMeetingRank[]
	league_of_heroes_rank_data: LeagueOfHeroesRank[]
	banner_uma_data: BannerUma[]
	banner_support_data: BannerSupport[]
	/** Select Step-Up banners, the third kind of planner row. */
	banner_step_up_data: BannerStepUp[]
	/** The ACTIVE plan's rows (see `active_plan_id`). `[]` for guests. */
	user_planned_banner_data: UserPlannedBanner[]
	/**
	 * Every plan the account holds, oldest first. `[]` for guests. Optional
	 * because an API from before plans existed omits it, and the two sides can
	 * be briefly out of step during a deploy.
	 */
	user_plans?: Plan[]
	/** Which plan `user_planned_banner_data` belongs to. `null` for guests. */
	active_plan_id?: number | null
	events_data: GameEvent[]
	champions_meeting_data: ChampionsMeeting[]
	league_of_heroes_event_data: LeagueOfHeroes[]
	banner_timeline_data: BannerTimelineForViewing[]
	/** Public reference data — campaigns and their purchasable products. */
	anniversary_event_data: AnniversaryEvent[]
	/** Public reference data — training scenarios. Markers only, no resources. */
	scenario_data: Scenario[]
	/** User-scoped; `[]` for guests, same as user_planned_banner_data. */
	user_planned_purchase_data: UserPlannedPurchase[]
	/** User-scoped. The ten cards picked at each step-up; `[]` for guests. */
	user_step_up_selection_data: UserStepUpSelection[]
	/**
	 * Flat, date-sorted timeline of every reward instant. The projection queries
	 * this for cumulative income totals rather than re-deriving a calendar from
	 * events_data / champions_meeting_data / league_of_heroes_event_data.
	 */
	income_ledger: IncomeLedgerRow[]
	/** Admin-editable tunables. Absent on an older API; see DEFAULT_CONSTANTS. */
	calculation_constants: CalculationConstants
}

/**
 * The timeline merges banner timelines, champions meetings and League of Heroes
 * events into one sorted array. Each element is exactly one of the three.
 *
 * TYPESCRIPT CONCEPT: Discriminated Unions
 * Every member carries a literal-typed `event_type` field, so narrowing on it
 * tells the compiler precisely which member you're holding:
 *   if (event.event_type === "champions_meeting") { // it's a ChampionsMeeting }
 *
 * This used to narrow structurally (`"track" in event`), which worked only for
 * as long as the three shapes stayed distinguishable — and stopped the moment
 * LeagueOfHeroes gained ChampionsMeeting's course fields. A tag can't converge.
 */
export type OrganizedTimelineData = (
	| ChampionsMeeting
	| LeagueOfHeroes
	| BannerTimelineForViewing
)[]

/** One element of the merged timeline array. */
export type TimelineEvent = OrganizedTimelineData[number]

/**
 * The union's narrowing helpers, kept beside the union itself — the same
 * arrangement as isSavedBanner/isLocalBanner in ./user.
 *
 * Prefer these over hand-written checks at call sites. Champions Meetings and
 * League of Heroes events are structurally indistinguishable from each other,
 * and BannerTimelineForViewing is structurally assignable to both (it shares
 * every base field), so any shape-based test is wrong in at least one direction.
 */
export function isRaceEvent(event: TimelineEvent): event is RaceEvent {
	return event.event_type === "champions_meeting" || event.event_type === "league_of_heroes"
}

export function isBannerTimeline(event: TimelineEvent): event is BannerTimelineForViewing {
	return event.event_type === "banner_timeline"
}

/**
 * The shape of the Calculator context value.
 *
 * TYPESCRIPT CONCEPT: React.Dispatch<SetStateAction<T>>
 * This is the type of the setter function from useState. It accepts either
 * a new value of type T, or a callback (prev: T) => T. When you expose a
 * setState function through context, always type it this way rather than
 * as a generic function type — it gives consumers full autocomplete.
 */
export interface CalculatorContextType {
	userStatsData: UserStats | null
	clubRankData: ClubRank[]
	teamTrialsRankData: TeamTrialsRank[]
	championsMeetingRankData: ChampionsMeetingRank[]
	leagueOfHeroesRankData: LeagueOfHeroesRank[]
	umaBannerData: BannerUma[]
	supportBannerData: BannerSupport[]
	stepUpBannerData: BannerStepUp[]
	gameEventsData: GameEvent[]
	championsMeetingData: ChampionsMeeting[]
	leagueOfHeroesData: LeagueOfHeroes[]
	userPlannedBannerData: UserPlannedBanner[]
	stagedBanners: UserPlannedBanner[]
	anniversaryEventData: AnniversaryEvent[]
	scenarioData: Scenario[]
	userPlannedPurchaseData: UserPlannedPurchase[]
	userStepUpSelectionData: UserStepUpSelection[]
	incomeLedger: IncomeLedgerRow[]
	calculationConstants: CalculationConstants
	timerIsGoing: boolean
	// The initial /calculator-data fetch. Exposed rather than gated inside the
	// provider so the app shell (navbar, footer) can paint immediately and only
	// the page area waits — see views/ApplicationViews.tsx. While isLoading is
	// true every collection below is still at its empty initial value, so a
	// consumer that renders during loading must tolerate that; the routed pages
	// stay behind the gate precisely so they never have to.
	isLoading: boolean
	fetchError: boolean
	organizedTimelineData: OrganizedTimelineData
	/**
	 * The account's plans, and which one `userPlannedBannerData` belongs to.
	 * `[]` and `null` for a guest, who has one unnamed plan in memory.
	 */
	plans: Plan[]
	activePlanId: number | null
	/** True when the open plan belongs to another account and is view-only. */
	isReadOnly: boolean
	/** True while a switch, create or delete is in flight. Disables the switcher. */
	isPlanBusy: boolean
	/**
	 * The plan actions. Each flushes any pending auto-save for the plan being
	 * left BEFORE it changes anything, resolves to whether it worked, and
	 * toasts its own failure, so a caller only has to close its menu on true.
	 */
	switchPlan: (planId: number) => Promise<boolean>
	/** Creates a plan (blank, or a copy of `copyFromId`) and switches to it. */
	createPlan: (name: string, copyFromId?: number) => Promise<boolean>
	renamePlan: (planId: number, name: string) => Promise<boolean>
	deletePlan: (planId: number) => Promise<boolean>
	/**
	 * Turn "separate resources" on or off for a plan. On: the server copies the
	 * stats on screen into the plan's own block, and from then on that plan
	 * reads and saves them there. Off: back to the account's stats.
	 */
	setSeparateIncome: (planId: number, on: boolean) => Promise<boolean>
	saveNow: () => Promise<void>
	setUserPlannedBannerData: Dispatch<SetStateAction<UserPlannedBanner[]>>
	setStagedBanners: Dispatch<SetStateAction<UserPlannedBanner[]>>
	setUserPlannedPurchaseData: Dispatch<SetStateAction<UserPlannedPurchase[]>>
	setUserStepUpSelectionData: Dispatch<SetStateAction<UserStepUpSelection[]>>
	setUserStatsData: Dispatch<SetStateAction<UserStats | null>>
}