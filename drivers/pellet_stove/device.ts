import Homey from 'homey';
import { HaasSohnApi, HaasSohnStatus } from '../../lib/haassohn-api.js';

type CapabilityType = 'boolean' | 'number' | 'string';
type PelletsAutoResetMode = 'none' | 'reset15' | 'reset30';

const OBJECT_AS_STRING_KEYS = new Set<string>([
  'meta.wlan_features',
]);

const DEFAULT_PELLETS_KG = 15;
const MIN_PELLETS_KG = 0;
const DEFAULT_MAX_PELLETS_KG = 30;

const STATE_TO_CAPABILITY: Record<string, string> = {
  prg: 'onoff',
  sp_temp: 'target_temperature',
  is_temp: 'measure_temperature',
  mode: 'stove_mode',
  zone: 'stove_zone',
  cleaning_in: 'stove_cleaning_in',
  maintenance_in: 'stove_maintenance_in',
  consumption: 'stove_consumption',
  eco_mode: 'stove_eco_mode',
  wprg: 'stove_weekprogram_active',
  ht_char: 'stove_heating_curve',
  ignitions: 'stove_ignitions',
  on_time: 'stove_on_time',
  'meta.eco_editable': 'meta_eco_editable',
};

const ERROR_CODE_MAP: Record<number, string[]> = {
  1: [
    'STB activated due to overheating',
    'Damaged fuse (F1) on the main unit',
    'Ignition short circuit',
  ],
  2: [
    'Burner is dirty',
    'Pellet hopper is empty',
    'Ignition fault',
    'Burner not seated properly',
    'Flame temperature sensor faulty',
    'Drop tube / auger blocked',
    'Auger motor faulty',
    'External air supply from outside connected',
  ],
  3: [
    'Flue gas paths / chimney are dirty',
    'Heating curve set too low',
    'Room temperature sensor is on the floor or on the wall',
  ],
  5: [
    'Burner is dirty',
    'Pellet hopper is empty',
    'Drop tube / auger blocked',
    'Room is too airtight - required combustion air cannot enter the room',
    'Flue gas temperature sensor faulty',
    'Auger motor faulty',
    'Pellet calorific value is insufficient',
  ],
  6: [
    'Firebox door is open during operation',
    'Door contact switch is not in the correct position',
    'Broken electrical cable to the door contact switch',
    'Loose contact on the door contact switch or main unit',
  ],
  7: [
    'Flue gas temperature sensor damaged or disconnected',
  ],
  8: [
    'Flue gas temperature sensor faulty',
  ],
  9: [
    'Warning: Firebox door is open during shutdown or standby',
  ],
  11: [
    'Room temperature sensor damaged or disconnected',
  ],
  12: [
    'Room temperature sensor faulty',
  ],
  13: [
    'Heating water temperature sensor faulty or disconnected',
  ],
  14: [
    'Water temperature sensor short circuit',
  ],
  15: [
    'Exhaust fan fault',
    'Exhaust fan power supply interrupted',
  ],
  18: [
    'Power outage',
  ],
  21: [
    'Burner is dirty',
    'Pellet hopper is empty',
    'Drop tube / auger blocked',
    'Room is too airtight - required combustion air cannot enter the room',
    'Flue gas temperature sensor faulty',
    'Auger motor faulty',
    'Pellet calorific value is insufficient',
  ],
  22: [
    'Chimney draft is too low',
    'Chimney draft is too high',
    'Burner is dirty',
    'Flue duct is too long (horizontal)',
    'Flue gas temperature sensor faulty',
  ],
  23: [
    'Flame temperature sensor damaged or disconnected',
  ],
  24: [
    'Lower temperature sensor damaged or disconnected',
  ],
  26: [
    'Pellet hopper is empty',
    'Burner not seated properly',
    'Burner is dirty',
    'Pellet calorific value is insufficient',
    'Drop tube / auger blocked',
    'Room is too airtight - required combustion air cannot enter the room',
    'Flame temperature sensor faulty',
    'Auger motor faulty',
  ],
  27: [
    'Burner is dirty',
    'Burner not seated properly',
    'Door does not seal',
  ],
  28: [
    'Burner / combustion chamber is dirty',
    'Lower temperature sensor faulty',
  ],
  33: [
    'Not connected to WLAN',
    'Incorrect WLAN PIN',
    'No IP address received',
  ],
  34: [
    'No internet connection available',
  ],
  40: [
    'Combustion chamber was not cleaned within the required interval',
  ],
  41: [
    'Maintenance interval exceeded (1000 kg)',
  ],
  43: [
    'Flame temperature sensor faulty',
  ],
  50: [
    'Backup battery discharged',
  ],
  60: [
    'Factory parameter errors were loaded',
  ],
  1000: [
    'Device restart',
  ],
};

const CAPABILITY_TYPES: Record<string, CapabilityType> = {
  onoff: 'boolean',
  target_temperature: 'number',
  measure_temperature: 'number',
  stove_eco_mode: 'boolean',
  stove_weekprogram_active: 'boolean',
  meta_eco_editable: 'boolean',
  stove_cleaning_in: 'number',
  stove_maintenance_in: 'number',
  stove_consumption: 'number',
  stove_pellets: 'number',
  stove_heating_curve: 'number',
  stove_ignitions: 'number',
  stove_on_time: 'number',
  stove_mode: 'string',
  stove_zone: 'number',
  stove_error: 'string',
  stove_error_state: 'boolean',
};

module.exports = class PelletStoveDevice extends Homey.Device {
  private api: HaasSohnApi | null = null;
  private pollInterval = 10;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private errorCount = 0;
  private ecoEditable = true;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private pelletsRemainingKg: number | null = null;
  private lastConsumptionKg: number | null = null;
  private pelletsAutoResetMode: PelletsAutoResetMode = 'none';
  private pelletsMaxKg = DEFAULT_MAX_PELLETS_KG;
  private pelletsHoldAutoReset = false;
  private suppressSettingsUpdate = false;

  async onInit() {
    this.log('Pellet stove device initialized');
    this.applySettings(this.getSettings());
    this.initializePelletsState();
    await this.syncCapabilities();
    this.registerCapabilityListeners();
    this.startPolling();
  }

  async onAdded() {
    this.log('Pellet stove device added');
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if (changedKeys.length === 0) {
      return;
    }
    if (this.suppressSettingsUpdate) {
      return;
    }

    if (changedKeys.some((key) => ['address', 'pin', 'pollInterval'].includes(key))) {
      this.applySettings(newSettings);
      this.startPolling();
    }

    if (changedKeys.includes('pellets_auto_reset')) {
      this.pelletsAutoResetMode = parsePelletsAutoResetMode(newSettings.pellets_auto_reset);
    }

    if (changedKeys.includes('pellets_max_kg')) {
      this.pelletsMaxKg = parsePelletsMaxKg(newSettings.pellets_max_kg);
      await this.updatePelletsCapabilityMax();
      if (this.pelletsRemainingKg !== null) {
        await this.setPelletsRemaining(this.pelletsRemainingKg, { updateSetting: true });
      }
    }

    if (changedKeys.includes('pellets_kg')) {
      await this.handlePelletsOverride(newSettings.pellets_kg);
    }
  }

  async onRenamed() {
    this.log('Pellet stove device renamed');
  }

  async onDeleted() {
    this.stopPolling();
    this.log('Pellet stove device deleted');
  }

  async setPelletsFromFlow(value: unknown) {
    await this.handlePelletsOverride(value);
  }

  async setWeeklyProgramFromFlow(value: unknown) {
    await this.handleWeekProgram(value);
  }

  async setEcoModeFromFlow(value: unknown) {
    await this.handleEcoMode(value);
  }

  private registerCapabilityListeners() {
    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async (value) => this.handleOnOff(value));
    }
    if (this.hasCapability('target_temperature')) {
      this.registerCapabilityListener('target_temperature', async (value) => this.handleTargetTemperature(value));
    }
    if (this.hasCapability('stove_eco_mode')) {
      this.registerCapabilityListener('stove_eco_mode', async (value) => this.handleEcoMode(value));
    }
    if (this.hasCapability('stove_weekprogram_active')) {
      this.registerCapabilityListener('stove_weekprogram_active', async (value) => this.handleWeekProgram(value));
    }
    if (this.hasCapability('stove_pellets')) {
      this.registerCapabilityListener('stove_pellets', async (value) => this.handlePelletsOverride(value));
    }
  }

  private async syncCapabilities() {
    await this.ensureCapabilityPresent('stove_error_state');
    await this.ensureCapabilityAbsent('meta_raw');
    await this.ensureCapabilityAbsent('meta_hw_version');
    await this.ensureCapabilityAbsent('meta_sw_version');
    await this.ensureCapabilityAbsent('meta_typ');
  }

  private async ensureCapabilityPresent(capabilityId: string) {
    if (this.hasCapability(capabilityId)) {
      return;
    }
    try {
      await this.addCapability(capabilityId);
    } catch (error) {
      this.error(`Failed to add capability ${capabilityId}`, error);
    }
  }

  private async ensureCapabilityAbsent(capabilityId: string) {
    if (!this.hasCapability(capabilityId)) {
      return;
    }
    try {
      await this.removeCapability(capabilityId);
    } catch (error) {
      this.error(`Failed to remove capability ${capabilityId}`, error);
    }
  }

  private applySettings(settings: { [key: string]: boolean | string | number | undefined | null }) {
    const address = normalizeAddress(settings.address, settings.port);
    const pin = String(settings.pin ?? '').trim();
    const pollInterval = Number(settings.pollInterval ?? 10);

    this.pollInterval = Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : 10;
    this.pelletsAutoResetMode = parsePelletsAutoResetMode(settings.pellets_auto_reset);
    this.pelletsMaxKg = parsePelletsMaxKg(settings.pellets_max_kg);

    if (!this.api) {
      this.api = new HaasSohnApi(address, pin);
    } else {
      this.api.setConfig(address, pin);
    }
  }

  private initializePelletsState() {
    const settings = this.getSettings();
    const storedRemaining = this.getStoreValue('pelletsRemainingKg');
    const storedConsumption = this.getStoreValue('pelletsLastConsumptionKg');
    const configuredRemaining = coerceNumber(settings.pellets_kg);
    this.pelletsMaxKg = parsePelletsMaxKg(settings.pellets_max_kg);
    void this.updatePelletsCapabilityMax();

    if (typeof storedRemaining === 'number') {
      this.pelletsRemainingKg = this.clampPelletsValue(storedRemaining);
    } else if (typeof configuredRemaining === 'number') {
      this.pelletsRemainingKg = this.clampPelletsValue(configuredRemaining);
    } else {
      this.pelletsRemainingKg = this.clampPelletsValue(DEFAULT_PELLETS_KG);
    }

    if (typeof storedConsumption === 'number') {
      this.lastConsumptionKg = storedConsumption;
    }

    if (this.pelletsRemainingKg !== null) {
      void this.setCapabilityValueIfChanged('stove_pellets', this.pelletsRemainingKg);
    }
  }

  private async updateMetaSettings(flat: Record<string, unknown>) {
    const settings = this.getSettings();
    const updates: Record<string, string> = {};

    const hwVersion = normalizeMetaValue(flat['meta.hw_version']);
    const swVersion = normalizeMetaValue(flat['meta.sw_version']);
    const deviceType = normalizeMetaValue(flat['meta.typ']);

    if (hwVersion !== undefined && hwVersion !== String(settings.meta_hw_version ?? '')) {
      updates.meta_hw_version = hwVersion;
    }
    if (swVersion !== undefined && swVersion !== String(settings.meta_sw_version ?? '')) {
      updates.meta_sw_version = swVersion;
    }
    if (deviceType !== undefined && deviceType !== String(settings.meta_typ ?? '')) {
      updates.meta_typ = deviceType;
    }

    if (Object.keys(updates).length > 0) {
      await this.updateSettingsSafely(updates);
    }
  }

  private async updatePelletsFromConsumption(consumptionKg: number) {
    if (!Number.isFinite(consumptionKg)) {
      return;
    }

    if (this.pelletsRemainingKg === null) {
      this.initializePelletsState();
    }

    if (this.lastConsumptionKg === null) {
      this.lastConsumptionKg = consumptionKg;
      await this.setStoreValue('pelletsLastConsumptionKg', consumptionKg);
      if (this.pelletsRemainingKg !== null) {
        await this.setCapabilityValueIfChanged('stove_pellets', this.pelletsRemainingKg);
      }
      return;
    }

    let delta = consumptionKg - this.lastConsumptionKg;
    if (!Number.isFinite(delta) || delta < 0) {
      delta = 0;
    }

    const currentRemaining = this.pelletsRemainingKg ?? 0;
    let nextRemaining = this.clampPelletsValue(currentRemaining - delta);

    if (nextRemaining === 0) {
      const resetValue = getPelletsAutoResetValue(this.pelletsAutoResetMode);
      if (resetValue !== null && !this.pelletsHoldAutoReset) {
        nextRemaining = resetValue;
      }
    }

    this.lastConsumptionKg = consumptionKg;
    await this.setStoreValue('pelletsLastConsumptionKg', consumptionKg);
    await this.setPelletsRemaining(nextRemaining, { updateSetting: true });
  }

  private async handlePelletsOverride(value: unknown) {
    const normalized = coerceNumber(value);
    if (typeof normalized !== 'number') {
      throw new Error('Invalid pellets value');
    }

    this.pelletsHoldAutoReset = false;
    await this.setPelletsRemaining(normalized, { updateSetting: true });
  }

  private async setPelletsRemaining(value: number, { updateSetting }: { updateSetting?: boolean } = {}) {
    const normalized = this.clampPelletsValue(value);
    if (this.pelletsRemainingKg === normalized) {
      if (updateSetting) {
        await this.updatePelletsSetting(normalized);
      }
      return;
    }

    this.pelletsRemainingKg = normalized;
    await this.setStoreValue('pelletsRemainingKg', normalized);
    await this.setCapabilityValueIfChanged('stove_pellets', normalized);
    if (updateSetting) {
      await this.updatePelletsSetting(normalized);
    }
  }

  private async updatePelletsSetting(value: number) {
    const settings = this.getSettings();
    const current = coerceNumber(settings.pellets_kg);
    if (typeof current === 'number' && Math.abs(current - value) < 0.01) {
      return;
    }
    await this.updateSettingsSafely({ pellets_kg: value });
  }

  private async updatePelletsCapabilityMax() {
    if (!this.hasCapability('stove_pellets')) {
      return;
    }
    try {
      await this.setCapabilityOptions('stove_pellets', { max: this.pelletsMaxKg });
    } catch (error) {
      this.error('Failed to update pellets capability max', error);
    }
  }

  private clampPelletsValue(value: number): number {
    if (!Number.isFinite(value)) {
      return DEFAULT_PELLETS_KG;
    }
    const rounded = Math.round(value);
    return Math.min(this.pelletsMaxKg, Math.max(MIN_PELLETS_KG, rounded));
  }

  private async updateSettingsSafely(updates: Record<string, string | number | boolean>) {
    try {
      this.suppressSettingsUpdate = true;
      await this.setSettings(updates);
    } finally {
      this.suppressSettingsUpdate = false;
    }
  }

  private startPolling() {
    this.stopPolling();
    this.scheduleNextPoll(0);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(delaySeconds: number) {
    const delayMs = Math.max(0, delaySeconds) * 1000;
    this.pollTimer = setTimeout(() => {
      void this.pollStatus();
    }, delayMs);
  }

  private async pollStatus() {
    if (!this.api) {
      return;
    }
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;

    try {
      const address = this.api.getAddress().trim();
      if (!address) {
        await this.setUnavailable('Missing device address');
        return;
      }

      const status = await this.api.getStatus();
      await this.applyStatus(status);
      this.errorCount = 0;
      await this.setAvailable();
    } catch (error) {
      this.errorCount += 1;
      this.error(`Polling failed (${this.errorCount})`, error);
      await this.setUnavailable('Unable to reach device');
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll(this.pollInterval);
    }
  }

  private async applyStatus(status: HaasSohnStatus) {
    const flat = flattenStatus(status);
    const ecoEditable = coerceBoolean(flat['meta.eco_editable']);
    if (typeof ecoEditable === 'boolean') {
      this.ecoEditable = ecoEditable;
    }

    await this.applyErrorState(flat);
    await this.updateMetaSettings(flat);
    const consumption = coerceNumber(flat['consumption']);
    if (typeof consumption === 'number') {
      await this.updatePelletsFromConsumption(consumption);
    }

    for (const [stateKey, capabilityId] of Object.entries(STATE_TO_CAPABILITY)) {
      if (!(stateKey in flat)) {
        continue;
      }
      const value = coerceValue(capabilityId, flat[stateKey]);
      if (value === undefined) {
        continue;
      }
      await this.setCapabilityValueIfChanged(capabilityId, value);
    }

  }

  private async applyErrorState(flat: Record<string, unknown>) {
    const errorNumber = getErrorNumber(flat);
    if (errorNumber === undefined) {
      return;
    }
    if (!errorNumber || errorNumber === 0) {
      this.pelletsHoldAutoReset = false;
      await this.setCapabilityValueIfChanged('stove_error', 'No error');
      await this.setCapabilityValueIfChanged('stove_error_state', false);
      if (this.lastErrorCode) {
        await this.unsetWarning();
        this.lastErrorCode = null;
        this.lastErrorMessage = null;
      }
      return;
    }

    if (errorNumber === 21 || errorNumber === 26) {
      this.pelletsHoldAutoReset = true;
      await this.setPelletsRemaining(0, { updateSetting: true });
    } else {
      this.pelletsHoldAutoReset = false;
    }

    const errorCode = formatErrorCode(errorNumber);
    const errorMessage = formatErrorMessage(errorCode, ERROR_CODE_MAP[errorNumber]);

    await this.setCapabilityValueIfChanged('stove_error', errorCode);
    await this.setCapabilityValueIfChanged('stove_error_state', true);

    if (this.lastErrorCode !== errorCode) {
      await this.setWarning(errorMessage);
      await this.createErrorNotification(errorMessage);
      this.lastErrorCode = errorCode;
      this.lastErrorMessage = errorMessage;
      return;
    }

    if (this.lastErrorMessage !== errorMessage) {
      await this.setWarning(errorMessage);
      this.lastErrorMessage = errorMessage;
    }
  }

  private async createErrorNotification(message: string) {
    try {
      await this.homey.notifications.createNotification({
        excerpt: `${this.getName()}: ${message}`,
      });
    } catch (error) {
      this.error('Failed to create error notification', error);
    }
  }

  private async setCapabilityValueIfChanged(capabilityId: string, value: unknown) {
    if (!this.hasCapability(capabilityId)) {
      return;
    }
    const currentValue = this.getCapabilityValue(capabilityId);
    if (Object.is(currentValue, value)) {
      return;
    }
    try {
      await this.setCapabilityValue(capabilityId, value);
    } catch (error) {
      this.error(`Failed to update capability ${capabilityId}`, error);
    }
  }

  private async handleOnOff(value: unknown) {
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid on/off value');
    }
    await this.sendCommand({ prg: normalized });
  }

  private async handleTargetTemperature(value: unknown) {
    if (this.getCapabilityValue('stove_weekprogram_active') === true) {
      throw new Error('Weekly program is active');
    }
    const normalized = coerceNumber(value);
    if (typeof normalized !== 'number') {
      throw new Error('Invalid target temperature');
    }
    await this.sendCommand({ sp_temp: normalized });
  }

  private async handleEcoMode(value: unknown) {
    if (!this.ecoEditable) {
      throw new Error('Eco mode is not editable');
    }
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid eco mode value');
    }
    await this.sendCommand({ eco_mode: normalized });
  }

  private async handleWeekProgram(value: unknown) {
    const normalized = coerceBoolean(value);
    if (typeof normalized !== 'boolean') {
      throw new Error('Invalid weekly program value');
    }
    await this.sendCommand({ wprg: normalized });
  }


  private async sendCommand(payload: Record<string, unknown>) {
    if (!this.api) {
      throw new Error('Device not configured');
    }
    this.stopPolling();
    await this.api.postStatus(payload);
    await this.pollStatus();
  }
};

function flattenStatus(status: HaasSohnStatus, path = '', output: Record<string, unknown> = {}) {
  Object.entries(status).forEach(([key, value]) => {
    const fullKey = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object') {
      if (Array.isArray(value) || OBJECT_AS_STRING_KEYS.has(fullKey)) {
        output[fullKey] = JSON.stringify(value);
      } else {
        flattenStatus(value as HaasSohnStatus, fullKey, output);
      }
    } else {
      output[fullKey] = value;
    }
  });
  return output;
}

function coerceValue(capabilityId: string, value: unknown): boolean | number | string | undefined {
  const type = CAPABILITY_TYPES[capabilityId];
  if (!type) {
    return undefined;
  }

  if (type === 'boolean') {
    return coerceBoolean(value);
  }
  if (type === 'number') {
    return coerceNumber(value);
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(lowered)) {
      return false;
    }
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function getErrorNumber(flat: Record<string, unknown>): number | undefined {
  const candidates = [
    flat['error.nr'],
    flat['error'],
    flat['err.nr'],
    flat['err'],
  ];

  for (const candidate of candidates) {
    const parsed = parseErrorNumber(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function parseErrorNumber(value: unknown): number | undefined {
  const direct = coerceNumber(value);
  if (direct !== undefined) {
    return direct;
  }
  if (typeof value === 'string') {
    const match = value.match(/(\d{1,4})/);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function formatErrorCode(errorNumber: number): string {
  if (errorNumber >= 1000) {
    return `F${errorNumber}`;
  }
  return `F${String(errorNumber).padStart(3, '0')}`;
}

function formatErrorMessage(errorCode: string, causes?: string[]): string {
  if (!causes || causes.length === 0) {
    return `${errorCode}: Unknown error`;
  }
  return `${errorCode}: ${causes.join(' / ')}`;
}

function parsePelletsAutoResetMode(value: unknown): PelletsAutoResetMode {
  if (value === 'reset15' || value === 'reset30') {
    return value;
  }
  return 'none';
}

function parsePelletsMaxKg(value: unknown): number {
  const parsed = coerceNumber(value);
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    return DEFAULT_MAX_PELLETS_KG;
  }
  return Math.max(MIN_PELLETS_KG, parsed);
}

function getPelletsAutoResetValue(mode: PelletsAutoResetMode): number | null {
  if (mode === 'reset15') {
    return 15;
  }
  if (mode === 'reset30') {
    return 30;
  }
  return null;
}

function normalizeMetaValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return undefined;
  }
}

function normalizeAddress(address?: string | number | boolean | null, port?: string | number | boolean | null): string {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return '';
  const portNumber = Number(port);
  if (Number.isFinite(portNumber)) {
    if (!/:\d+$/.test(trimmed)) {
      return `${trimmed}:${portNumber}`;
    }
  }
  return trimmed;
}
