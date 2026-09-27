/**
 * A named pull plan: a list of planned banner rows, and nothing else.
 *
 * A PLAN HOLDS CHOICES. THE ACCOUNT HOLDS FACTS. Carats, tickets, ranks, the
 * income toggles, planned purchases and step-up picks all belong to the
 * account, never to the plan. Step-up picks are the same whichever plan is
 * open. The stats (`userStatsData`) and the planned purchases
 * (`userPlannedPurchaseData`) are the OPEN PLAN'S: normally the account's
 * own, but a plan with "separate resources" on reads its own copy of both,
 * for people who plan for more than one game account. Which one is the
 * server's decision (`income_profile_id` says which); the client stores
 * whatever GET /plans/<id> hands it, in the same shape either way. That is why
 * the projection engine (useBannerResources) needed no change for plans: it
 * reads the same `userPlannedBannerData`, `userStatsData` and
 * `userPlannedPurchaseData` it always did, which now mean "the active plan's".
 *
 * Full reasoning, including why this makes a plan safe to copy between
 * accounts later: backend/docs/data-model.md ("`Plan`").
 *
 * A guest has one unnamed plan in memory, so for a guest `plans` is `[]` and
 * `activePlanId` is `null`. That pair is how the UI knows to hide the switcher.
 */
import type { UserPlannedPurchase } from "./anniversary"
import type { UserPlannedBanner, UserStats } from "./user"

export interface Plan {
	id: number
	/** Opaque URL-safe identifier returned by calculator-data. */
	public_id?: string
	name: string
	is_active: boolean
	/**
	 * Non-null when the plan reads its own stats ("separate resources") rather
	 * than the account's. Read-only; the switch is `separate_income` on the
	 * PATCH route (planSetSeparateIncome). Absent from an API older than this.
	 */
	income_profile_id?: number | null
	/** ISO instant. Moves on rename, on activate, and when the rows are saved. */
	updated_at: string
}

/** POST /plans and GET /plans/<id>: a plan together with its banner rows. */
export interface PlanWithRows {
	plan: Plan
	/**
	 * THIS plan's stats, shaped exactly like the same key on GET
	 * /calculator-data. Optional only because an API from before separate
	 * resources existed omits it; the provider then keeps what is on screen.
	 */
	user_stats_data?: UserStats
	/** Shaped and ordered exactly like the same key on GET /calculator-data. */
	user_planned_banner_data: UserPlannedBanner[]
	/**
	 * THIS plan's purchases: the ones of the same stats block `user_stats_data`
	 * came from. Optional because an API from before purchases followed the
	 * profile omits it; the provider then keeps what is on screen.
	 */
	user_planned_purchase_data?: UserPlannedPurchase[]
}

/**
 * The most plans an account can hold. Mirrors PLAN_CAP in the backend's
 * models/plan.py, which is the one that is enforced; this copy only lets the
 * UI disable "New plan" up front instead of offering a button that 400s.
 */
export const PLAN_CAP = 5

/** Matches Plan.name's max_length on the server. */
export const PLAN_NAME_MAX_LENGTH = 40
