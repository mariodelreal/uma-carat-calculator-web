/**
 * CalculatorProvider's plan actions.
 *
 * What is pinned here is ORDER, because that is where the data loss lives.
 * The server deletes every banner row a save does not name, and the rows in
 * React state are the only copy of an unsaved edit. So:
 *
 *   - an edit made in plan A must be saved TO PLAN A, by id, before plan B's
 *     rows replace it on screen;
 *   - if that save fails, nothing may move;
 *   - rows that just arrived from the server are not an edit and must not arm
 *     a save of their own;
 *   - a pending save for a plan that is being deleted must be dropped, not
 *     fired at an id that no longer exists.
 *
 * None of these throw when they break. They lose a user's banners.
 */

import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalculatorProvider } from '../services/CalculatorProvider'
import { useCalculatorData } from '../services/CalculatorContext'
import {
	initialCalculatorDataFetch,
	userCalculatorDataPatch,
} from '../services/calculatorFetchCalls'
import {
	planActivate,
	planCreate,
	planDelete,
	planFetch,
	planFetchPublic,
	planSetSeparateIncome,
} from '../services/planFetchCalls'
import { clearAuthToken, setAuthToken } from '../services/authToken'
import type {
	BannerUma,
	CalculatorContextType,
	CalculatorData,
	Plan,
	UserPlannedBanner,
	UserPlannedPurchase,
	UserStats,
} from '../types'

// Partial mock: the payload converters (toBannerPayload and friends) stay real,
// because what the PATCH is CALLED WITH is the thing under test.
vi.mock('../services/calculatorFetchCalls', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/calculatorFetchCalls')>()),
	initialCalculatorDataFetch: vi.fn(),
	userCalculatorDataPatch: vi.fn(),
}))
vi.mock('../services/planFetchCalls', () => ({
	planActivate: vi.fn(),
	planCreate: vi.fn(),
	planDelete: vi.fn(),
	planFetch: vi.fn(),
	planFetchPublic: vi.fn(),
	planRename: vi.fn(),
	planSetSeparateIncome: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedInitialFetch = vi.mocked(initialCalculatorDataFetch)
const mockedPatch = vi.mocked(userCalculatorDataPatch)
const mockedActivate = vi.mocked(planActivate)
const mockedCreate = vi.mocked(planCreate)
const mockedDelete = vi.mocked(planDelete)
const mockedPlanFetch = vi.mocked(planFetch)
const mockedPublicPlanFetch = vi.mocked(planFetchPublic)
const mockedSetSeparateIncome = vi.mocked(planSetSeparateIncome)

const json = (body: unknown, status = 200): Response =>
	({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

const PLAN_A: Plan = { id: 1, public_id: 'MainPlan', name: 'Main plan', is_active: true, updated_at: '2026-09-17T00:00:00Z' }
const PLAN_B: Plan = { id: 2, public_id: 'WhatIf12', name: 'What if', is_active: false, updated_at: '2026-09-17T00:00:00Z' }

/** A saved row. Only what toBannerPayload reads: an id, a target, two counts. */
const row = (id: number, bannerId: number, pulls: number, plan: number): UserPlannedBanner =>
	({
		id,
		user: 1,
		plan,
		number_of_pulls: pulls,
		reserved_copies: 0,
		banner_uma: { id: bannerId } as BannerUma,
		banner_support: null,
		banner_step_up: null,
	}) as UserPlannedBanner

const ROWS_A = [row(10, 100, 50, 1)]
const ROWS_B = [row(20, 200, 75, 2)]

/** Only the field the tests look at; the provider stores the object whole. */
const STATS_B = { current_carat: 4321 } as UserStats
/** Plan B's block has one purchase; the account (plan A's block) has none. */
const PURCHASES_B: UserPlannedPurchase[] = [{ id: 30, user: 1, product: 5, quantity: 2 }]

const calculatorData = (): CalculatorData =>
	({
		user_stats_data: { current_carat: 0 },
		club_rank_data: [],
		team_trials_rank_data: [],
		champions_meeting_rank_data: [],
		league_of_heroes_rank_data: [],
		banner_uma_data: [],
		banner_support_data: [],
		banner_step_up_data: [],
		user_planned_banner_data: ROWS_A,
		user_plans: [PLAN_A, PLAN_B],
		active_plan_id: PLAN_A.id,
		events_data: [],
		champions_meeting_data: [],
		league_of_heroes_event_data: [],
		banner_timeline_data: [],
		anniversary_event_data: [],
		scenario_data: [],
		user_planned_purchase_data: [],
		user_step_up_selection_data: [],
		income_ledger: [],
	}) as unknown as CalculatorData

// The latest context value, so a test can call the plan actions directly and
// read state back without going through the DOM. Captured in an effect, not
// during render (a component may not write to anything outside itself while
// rendering); act() flushes effects, so it is current by the time a test reads.
const latest: { current: CalculatorContextType | null } = { current: null }
const currentPath: { current: string } = { current: '' }
const currentNavigate: { current: ReturnType<typeof useNavigate> | null } = { current: null }
const Probe = () => {
	const value = useCalculatorData()
	const { pathname } = useLocation()
	const navigate = useNavigate()
	useEffect(() => {
		latest.current = value
		currentPath.current = pathname
		currentNavigate.current = navigate
	})
	return null
}
const ctx = (): CalculatorContextType => {
	if (!latest.current) throw new Error('Probe has not rendered yet')
	return latest.current
}

const renderLoaded = async (initialPath = '/app') => {
	const view = render(
		<MemoryRouter initialEntries={[initialPath]}>
			<CalculatorProvider>
				<Probe />
			</CalculatorProvider>
		</MemoryRouter>
	)
	await waitFor(() => expect(latest.current?.isLoading).toBe(false))
	return view
}

/** Change plan A's one row, the way BannerRow's pull field does. Arms the timer. */
const editOpenPlan = async (pulls: number): Promise<void> => {
	await act(async () => {
		ctx().setUserPlannedBannerData((prev) =>
			prev.map((banner) => ({ ...banner, number_of_pulls: pulls }))
		)
	})
	expect(ctx().timerIsGoing).toBe(true)
}

beforeEach(() => {
	latest.current = null
	currentPath.current = ''
	currentNavigate.current = null
	localStorage.clear()
	sessionStorage.clear()
	vi.clearAllMocks()
	setAuthToken('token')
	mockedInitialFetch.mockResolvedValue(json(calculatorData()))
	mockedPatch.mockResolvedValue(json({ message: 'ok' }))
	mockedActivate.mockResolvedValue(json({ ...PLAN_B, is_active: true }))
	mockedPlanFetch.mockResolvedValue(
		json({
			plan: PLAN_B,
			user_stats_data: STATS_B,
			user_planned_banner_data: ROWS_B,
			user_planned_purchase_data: PURCHASES_B,
		})
	)
	mockedPublicPlanFetch.mockResolvedValue(
		json({
			plan: { ...PLAN_B, id: 3, public_id: 'Share123', name: 'Shared plan' },
			user_stats_data: STATS_B,
			user_planned_banner_data: [row(30, 300, 85, 3)],
		})
	)
})

describe('CalculatorProvider plans', () => {
	it('loads the plan list and which plan the rows belong to', async () => {
		await renderLoaded()
		expect(ctx().plans.map((plan) => plan.name)).toEqual(['Main plan', 'What if'])
		expect(ctx().activePlanId).toBe(1)
		expect(ctx().userPlannedBannerData).toEqual(ROWS_A)
	})

	it('hides plans from an API that predates them', async () => {
		const old = calculatorData() as Partial<CalculatorData>
		delete old.user_plans
		delete old.active_plan_id
		mockedInitialFetch.mockResolvedValue(json(old))

		await renderLoaded()

		expect(ctx().plans).toEqual([])
		expect(ctx().activePlanId).toBeNull()
	})

	it('saves a pending edit to the plan it was made in before switching', async () => {
		await renderLoaded()
		await editOpenPlan(999)

		let worked = false
		await act(async () => {
			worked = await ctx().switchPlan(PLAN_B.id)
		})

		expect(worked).toBe(true)
		// One save, and it names plan A with plan A's edited row.
		expect(mockedPatch).toHaveBeenCalledTimes(1)
		const [planId, , banners] = mockedPatch.mock.calls[0]
		expect(planId).toBe(PLAN_A.id)
		expect(banners).toEqual([expect.objectContaining({ id: 10, number_of_pulls: 999 })])
		// And it went out BEFORE plan B was asked for.
		expect(mockedPatch.mock.invocationCallOrder[0]).toBeLessThan(
			mockedPlanFetch.mock.invocationCallOrder[0]
		)
		// Now on B, with B's rows.
		expect(ctx().activePlanId).toBe(PLAN_B.id)
		expect(ctx().userPlannedBannerData).toEqual(ROWS_B)
		expect(ctx().plans.find((plan) => plan.id === PLAN_B.id)?.is_active).toBe(true)
		expect(ctx().plans.find((plan) => plan.id === PLAN_A.id)?.is_active).toBe(false)
		expect(currentPath.current).toBe('/app/WhatIf12')
	})

	it('opens the plan named by a direct public-id URL', async () => {
		await renderLoaded('/app/WhatIf12')

		await waitFor(() => expect(ctx().activePlanId).toBe(PLAN_B.id))

		expect(mockedActivate).toHaveBeenCalledWith(PLAN_B.id)
		expect(mockedPlanFetch).toHaveBeenCalledWith(PLAN_B.id)
		expect(ctx().userPlannedBannerData).toEqual(ROWS_B)
	})

	it('opens another users public plan read-only without activating or saving it', async () => {
		await renderLoaded('/app/Share123')

		await waitFor(() => expect(ctx().activePlanId).toBe(3))

		expect(mockedPublicPlanFetch).toHaveBeenCalledWith('Share123')
		expect(ctx().isReadOnly).toBe(true)
		expect(ctx().userPlannedBannerData[0].number_of_pulls).toBe(85)
		expect(ctx().userStatsData?.current_carat).toBe(STATS_B.current_carat)
		expect(ctx().userPlannedPurchaseData).toEqual([])
		expect(mockedActivate).not.toHaveBeenCalled()

		await act(async () => {
			ctx().setUserPlannedBannerData((prev) =>
				prev.map((banner) => ({ ...banner, number_of_pulls: 999 }))
			)
			await ctx().saveNow()
		})

		expect(ctx().userPlannedBannerData[0].number_of_pulls).toBe(85)
		expect(mockedPatch).not.toHaveBeenCalled()
	})

	it.each(['/app/timeline', '/app/selectors'])(
		'does not treat the %s route as a public plan ID',
		async (path) => {
			await renderLoaded(path)

			expect(mockedPublicPlanFetch).not.toHaveBeenCalled()
		}
	)

	it('returns to the last active owned plan at /app', async () => {
		const data = calculatorData()
		data.active_plan_id = PLAN_B.id
		data.user_planned_banner_data = ROWS_B
		mockedInitialFetch.mockResolvedValue(json(data))

		await renderLoaded('/app')

		await waitFor(() => {
			expect(ctx().activePlanId).toBe(PLAN_B.id)
			expect(currentPath.current).toBe('/app/WhatIf12')
		})
		expect(mockedActivate).not.toHaveBeenCalled()
		expect(mockedPlanFetch).not.toHaveBeenCalled()
	})

	it('returns to the owned plan last open before visiting Timeline', async () => {
		await renderLoaded()
		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})

		await act(async () => {
			currentNavigate.current?.('/app/timeline')
		})
		await act(async () => {
			currentNavigate.current?.('/app')
		})

		await waitFor(() => {
			expect(ctx().activePlanId).toBe(PLAN_B.id)
			expect(currentPath.current).toBe('/app/WhatIf12')
		})
		expect(mockedPublicPlanFetch).not.toHaveBeenCalled()
	})

	it('falls back to the first plan if the remembered plan is no longer available', async () => {
		const data = calculatorData()
		data.active_plan_id = 999
		data.user_planned_banner_data = []
		mockedInitialFetch.mockResolvedValue(json(data))
		mockedActivate.mockResolvedValue(json({ ...PLAN_A, is_active: true }))
		mockedPlanFetch.mockResolvedValue(json({
			plan: PLAN_A,
			user_stats_data: { current_carat: 123 },
			user_planned_banner_data: ROWS_A,
			user_planned_purchase_data: [],
		}))

		await renderLoaded('/app')

		await waitFor(() => {
			expect(ctx().activePlanId).toBe(PLAN_A.id)
			expect(currentPath.current).toBe('/app/MainPlan')
		})
		expect(mockedActivate).toHaveBeenCalledWith(PLAN_A.id)
		expect(mockedPlanFetch).toHaveBeenCalledWith(PLAN_A.id)
	})

	it('leaves a guest local plan unchanged at /app', async () => {
		clearAuthToken()
		const data = calculatorData()
		data.user_plans = []
		data.active_plan_id = null
		data.user_planned_banner_data = ROWS_B
		mockedInitialFetch.mockResolvedValue(json(data))

		await renderLoaded('/app')

		expect(ctx().activePlanId).toBeNull()
		expect(ctx().userPlannedBannerData).toEqual(ROWS_B)
		expect(currentPath.current).toBe('/app')
		expect(mockedActivate).not.toHaveBeenCalled()
		expect(mockedPlanFetch).not.toHaveBeenCalled()
	})

	it('restores a guest local plan after viewing a shared plan', async () => {
		clearAuthToken()
		const data = calculatorData()
		data.user_plans = []
		data.active_plan_id = null
		data.user_planned_banner_data = ROWS_A
		mockedInitialFetch.mockResolvedValue(json(data))

		await renderLoaded('/app')
		const localStats = ctx().userStatsData
		const localRows = ctx().userPlannedBannerData

		await act(async () => {
			currentNavigate.current?.('/app/Share123')
		})
		await waitFor(() => expect(ctx().isReadOnly).toBe(true))
		expect(ctx().userPlannedBannerData[0].number_of_pulls).toBe(85)

		await act(async () => {
			currentNavigate.current?.('/app')
		})
		await waitFor(() => {
			expect(currentPath.current).toBe('/app')
			expect(ctx().isReadOnly).toBe(false)
		})
		expect(ctx().activePlanId).toBeNull()
		expect(ctx().userStatsData).toBe(localStats)
		expect(ctx().userPlannedBannerData).toBe(localRows)
	})

	it('does not switch back when plans are changed repeatedly', async () => {
		await renderLoaded()

		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})
		await act(async () => {
			await ctx().switchPlan(PLAN_A.id)
		})
		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})

		expect(ctx().activePlanId).toBe(PLAN_B.id)
		expect(currentPath.current).toBe('/app/WhatIf12')
		expect(mockedPlanFetch.mock.calls.map(([planId]) => planId)).toEqual([
			PLAN_B.id,
			PLAN_A.id,
			PLAN_B.id,
		])
	})

	it('does not arm a save for rows that just arrived from the server', async () => {
		await renderLoaded()

		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})

		// Nothing was pending, so nothing was flushed, and loading B's rows must
		// not count as an edit of B.
		expect(mockedPatch).not.toHaveBeenCalled()
		expect(ctx().timerIsGoing).toBe(false)
	})

	it('the next edit after a switch saves to the NEW plan', async () => {
		await renderLoaded()
		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})

		await editOpenPlan(5)
		await act(async () => {
			await ctx().saveNow()
		})

		expect(mockedPatch).toHaveBeenCalledTimes(1)
		const [planId, , banners] = mockedPatch.mock.calls[0]
		expect(planId).toBe(PLAN_B.id)
		expect(banners).toEqual([expect.objectContaining({ id: 20, number_of_pulls: 5 })])
	})

	it('stays put, rows and all, when the save before a switch fails', async () => {
		mockedPatch.mockResolvedValue(json({ error: 'nope' }, 500))
		await renderLoaded()
		await editOpenPlan(999)

		let worked = true
		await act(async () => {
			worked = await ctx().switchPlan(PLAN_B.id)
		})

		expect(worked).toBe(false)
		expect(mockedPlanFetch).not.toHaveBeenCalled()
		expect(mockedActivate).not.toHaveBeenCalled()
		expect(ctx().activePlanId).toBe(PLAN_A.id)
		// The unsaved edit is still on screen, not replaced and not reverted.
		expect(ctx().userPlannedBannerData[0].number_of_pulls).toBe(999)
	})

	it('clears staged rows on a switch so they cannot be added to another plan', async () => {
		await renderLoaded()
		await act(async () => {
			ctx().setStagedBanners([{ tempId: 1, number_of_pulls: 0, reserved_copies: 0 } as UserPlannedBanner])
		})

		await act(async () => {
			await ctx().switchPlan(PLAN_B.id)
		})

		expect(ctx().stagedBanners).toEqual([])
	})

	it('flushes before creating a copy, then opens the copy', async () => {
		const copy: Plan = { id: 3, public_id: 'MainCp12', name: 'Main plan copy', is_active: false, updated_at: '2026-09-17T00:00:00Z' }
		const copiedRows = [row(30, 100, 999, 3)]
		mockedCreate.mockResolvedValue(json({ plan: copy, user_planned_banner_data: copiedRows }, 201))
		mockedActivate.mockResolvedValue(json({ ...copy, is_active: true }))
		await renderLoaded()
		await editOpenPlan(999)

		await act(async () => {
			await ctx().createPlan('Main plan copy', PLAN_A.id)
		})

		// The edit reached the server before the copy was taken from it.
		expect(mockedPatch.mock.invocationCallOrder[0]).toBeLessThan(
			mockedCreate.mock.invocationCallOrder[0]
		)
		expect(mockedCreate).toHaveBeenCalledWith('Main plan copy', PLAN_A.id)
		expect(ctx().plans.map((plan) => plan.id)).toEqual([1, 2, 3])
		expect(ctx().activePlanId).toBe(3)
		expect(ctx().userPlannedBannerData).toEqual(copiedRows)
		expect(currentPath.current).toBe('/app/MainCp12')
	})

	it('drops, rather than fires, a pending save for the plan being deleted', async () => {
		mockedDelete.mockResolvedValue(json({ active_plan_id: PLAN_B.id }))
		await renderLoaded()
		await editOpenPlan(999)

		await act(async () => {
			await ctx().deletePlan(PLAN_A.id)
		})

		expect(mockedPatch).not.toHaveBeenCalled()
		expect(ctx().timerIsGoing).toBe(false)
		// Landed where the server said, with that plan's rows.
		expect(ctx().plans.map((plan) => plan.id)).toEqual([PLAN_B.id])
		expect(ctx().activePlanId).toBe(PLAN_B.id)
		expect(ctx().userPlannedBannerData).toEqual(ROWS_B)
		expect(currentPath.current).toBe('/app/WhatIf12')
	})

	it('keeps the open plan and its pending edit when deleting a different plan', async () => {
		mockedDelete.mockResolvedValue(json({ active_plan_id: PLAN_A.id }))
		await renderLoaded()
		await editOpenPlan(999)

		await act(async () => {
			await ctx().deletePlan(PLAN_B.id)
		})

		// The edit to A was still wanted, so it was saved (to A), not dropped.
		expect(mockedPatch).toHaveBeenCalledTimes(1)
		expect(mockedPatch.mock.calls[0][0]).toBe(PLAN_A.id)
		expect(mockedPlanFetch).not.toHaveBeenCalled()
		expect(ctx().activePlanId).toBe(PLAN_A.id)
		expect(ctx().plans.map((plan) => plan.id)).toEqual([PLAN_A.id])
	})

	describe('separate resources', () => {
		it('a switch brings the plan\'s stats with its rows', async () => {
			await renderLoaded()
			expect(ctx().userStatsData?.current_carat).toBe(0)

			await act(async () => {
				await ctx().switchPlan(PLAN_B.id)
			})

			expect(ctx().userStatsData?.current_carat).toBe(4321)
			// Stats from the server are not an edit either.
			expect(ctx().timerIsGoing).toBe(false)
		})

		it('keeps the stats on screen when an older API sends none', async () => {
			mockedPlanFetch.mockResolvedValue(json({ plan: PLAN_B, user_planned_banner_data: ROWS_B }))
			await renderLoaded()

			await act(async () => {
				await ctx().switchPlan(PLAN_B.id)
			})

			expect(ctx().userStatsData?.current_carat).toBe(0)
			expect(ctx().userPlannedBannerData).toEqual(ROWS_B)
		})

		it('a switch brings the plan\'s purchases with its stats', async () => {
			await renderLoaded()
			expect(ctx().userPlannedPurchaseData).toEqual([])

			await act(async () => {
				await ctx().switchPlan(PLAN_B.id)
			})

			expect(ctx().userPlannedPurchaseData).toEqual(PURCHASES_B)
			// Purchases from the server are not an edit either.
			expect(ctx().timerIsGoing).toBe(false)
		})

		it('keeps the purchases on screen when an older API sends none', async () => {
			mockedInitialFetch.mockResolvedValue(
				json({ ...calculatorData(), user_planned_purchase_data: PURCHASES_B })
			)
			mockedPlanFetch.mockResolvedValue(
				json({ plan: PLAN_B, user_stats_data: STATS_B, user_planned_banner_data: ROWS_B })
			)
			await renderLoaded()

			await act(async () => {
				await ctx().switchPlan(PLAN_B.id)
			})

			expect(ctx().userPlannedPurchaseData).toEqual(PURCHASES_B)
			expect(ctx().userStatsData?.current_carat).toBe(4321)
		})

		it('flushes the pending edit BEFORE turning it on, then shows the new numbers', async () => {
			await renderLoaded()
			await editOpenPlan(999)
			mockedSetSeparateIncome.mockResolvedValue(json({ ...PLAN_A, income_profile_id: 7 }))
			mockedPlanFetch.mockResolvedValue(
				json({
					plan: { ...PLAN_A, income_profile_id: 7 },
					user_stats_data: { current_carat: 555 },
					user_planned_banner_data: ROWS_A,
				})
			)

			let worked = false
			await act(async () => {
				worked = await ctx().setSeparateIncome(PLAN_A.id, true)
			})

			expect(worked).toBe(true)
			// The save went out first: the server seeds the copy from the database.
			expect(mockedPatch).toHaveBeenCalledTimes(1)
			expect(mockedPatch.mock.invocationCallOrder[0]).toBeLessThan(
				mockedSetSeparateIncome.mock.invocationCallOrder[0]
			)
			expect(mockedSetSeparateIncome).toHaveBeenCalledWith(PLAN_A.id, true)
			expect(ctx().plans.find((plan) => plan.id === PLAN_A.id)?.income_profile_id).toBe(7)
			expect(ctx().userStatsData?.current_carat).toBe(555)
			expect(ctx().timerIsGoing).toBe(false)
		})

		it('changes nothing when the save before it fails', async () => {
			await renderLoaded()
			await editOpenPlan(999)
			mockedPatch.mockResolvedValue(json({ error: 'nope' }, 500))

			let worked = true
			await act(async () => {
				worked = await ctx().setSeparateIncome(PLAN_A.id, true)
			})

			expect(worked).toBe(false)
			expect(mockedSetSeparateIncome).not.toHaveBeenCalled()
			expect(ctx().userStatsData?.current_carat).toBe(0)
		})
	})
})
