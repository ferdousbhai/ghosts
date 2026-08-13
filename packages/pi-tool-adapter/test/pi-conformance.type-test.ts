import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type {
  PiAgentTool,
  PiToolResult,
  PiToolUpdateCallback,
} from "../src/index";

type AssertAssignable<Expected, Actual extends Expected> = Actual;

/** Fails root typecheck if the structural adapter drifts from pinned Pi 0.84.1. */
export type PiAgentToolConformance = AssertAssignable<
  AgentTool,
  PiAgentTool
>;
export type PiToolResultConformance = AssertAssignable<
  AgentToolResult<unknown>,
  PiToolResult<unknown>
>;
export type PiToolUpdateCallbackConformance = AssertAssignable<
  AgentToolUpdateCallback<unknown>,
  PiToolUpdateCallback<unknown>
>;
