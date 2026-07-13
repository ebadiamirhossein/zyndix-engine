import "server-only";

import { db } from "@/lib/db";

import { clearSettingsCache, createSettingsStore } from "./settings/core";

export {
  clearSettingsCache,
  createSettingsStore,
  SETTING_KEYS,
  type ActiveSetting,
  type SettingKey,
} from "./settings/core";

const store = createSettingsStore(db);

export const getActiveSetting = store.getActiveSetting;
export const getAllActiveSettings = store.getAllActiveSettings;
export const writeNewVersion = store.writeNewVersion;
