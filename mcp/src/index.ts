export { OrchidClient, OrchidError } from './client.js'
export type {
  ClientOptions,
  DmxSnapshot,
  Fixture,
  FixtureGroup,
  FunctionSummary,
  Plan,
  PlanFixture,
  Universe,
} from './client.js'

export { exportSpec } from './spec/export.js'
export type { ExportOptions } from './spec/export.js'

export { applySpec, planApply, SpecError } from './spec/apply.js'
export type { ApplyOptions, ApplyReport, ActionKind, PlannedAction } from './spec/apply.js'

export { SPEC_VERSION } from './spec/types.js'
export type {
  ChannelRef,
  ConsoleSpec,
  FixtureGroupSpec,
  FixtureSpec,
  FunctionSpec,
  PatchSpec,
  ShowSpec,
  StagePlacement,
  StageSpec,
  UniverseSpec,
  WidgetSpec,
} from './spec/types.js'
