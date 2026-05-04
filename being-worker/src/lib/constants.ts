// #599: プラン制限定数

export const PLAN_LIMITS = {
  free: { maxNodes: 500, maxBeings: 1 },
  pro: { maxNodes: Infinity, maxBeings: 3 },
  admin: { maxNodes: Infinity, maxBeings: Infinity },
} as const

export type PlanKey = keyof typeof PLAN_LIMITS
