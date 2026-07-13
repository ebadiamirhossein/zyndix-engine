import "server-only";

import { db } from "@/lib/db";

import { createStateStore } from "./state/core";

export {
  createStateStore,
  IllegalTransitionError,
  TransitionError,
  type LeadRow,
} from "./state/core";

const store = createStateStore(db);

export const getLead = store.getLead;
export const transition = store.transition;
