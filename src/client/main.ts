import '../styles.css';
import { ApiClient, ApiClientError, type IdentityData } from './api';
import { IdentityController, type IdentityState } from './identity';
import {
  renderAdminImport,
  renderAdminInsights,
  renderAdminSchedule,
  renderCenterSchedule,
  renderUnauthorized,
  renderVolunteerDashboard,
  type AdminImportActions,
  type AdminScheduleData,
  type AvailabilityException,
  type AvailabilityInterval,
  type CenterCandidate,
  type CenterScheduleData,
  type InsightsData,
  type ImportRunData,
  type VolunteerDashboardData,
  type ViewRole
} from './views';

export interface ClientConfig {
  appsScriptUrl: string;
  oauthClientId: string;
}

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  appsScriptUrl: '',
  oauthClientId: ''
};

const ROUTES = {
  volunteer: ['dashboard'],
  administrator: ['schedule', 'import', 'insights', 'centers'],
  'center-contact': ['centers']
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES][number];

interface Runtime {
  document: Document;
  app: HTMLElement;
  identityHost: HTMLElement | null;
  config: ClientConfig;
  api: ApiClient;
  identity: IdentityController;
  profile?: IdentityData;
  route: Route;
  rendering: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseRevision(value: unknown): number | string | undefined {
  return typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' ? value : undefined;
}

function parseInterval(value: unknown): AvailabilityInterval | undefined {
  if (!isRecord(value)) return undefined;
  const weekday = numberValue(value.weekday);
  const start = stringValue(value.start);
  const end = stringValue(value.end);
  if (weekday === undefined || start === undefined || end === undefined) return undefined;
  const interval: AvailabilityInterval = { weekday, start, end };
  const id = stringValue(value.id);
  const timeZone = stringValue(value.timeZone);
  if (id !== undefined) interval.id = id;
  if (timeZone !== undefined) interval.timeZone = timeZone;
  return interval;
}

function parseException(value: unknown): AvailabilityException | undefined {
  if (!isRecord(value)) return undefined;
  const interval = isRecord(value.interval) ? value.interval : value;
  const date = stringValue(value.date);
  const start = stringValue(interval.start);
  const end = stringValue(interval.end);
  const timeZone = stringValue(interval.timeZone);
  const kind = value.kind === 'available' || value.kind === 'unavailable' ? value.kind : undefined;
  if (!date || !start || !end || !timeZone || !kind) return undefined;
  const exception: AvailabilityException = { date, start, end, timeZone, kind };
  const id = stringValue(value.id);
  const reason = stringValue(value.reason);
  if (id !== undefined) exception.id = id;
  if (reason !== undefined) exception.reason = reason;
  return exception;
}

function parseDashboard(value: unknown): VolunteerDashboardData {
  const data = isRecord(value) ? value : {};
  const volunteer = isRecord(data.volunteer) ? data.volunteer : data;
  const recurringSource = data.recurringAvailability ?? volunteer.recurringAvailability;
  const recurringAvailability = arrayValue(recurringSource).map(parseInterval).filter((item): item is AvailabilityInterval => item !== undefined);
  const exceptions = arrayValue(data.exceptions).map(parseException).filter((item): item is AvailabilityException => item !== undefined);
  const sessionsById: Record<string, Record<string, unknown>> = {};
  for (const item of arrayValue(data.sessions)) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (id) sessionsById[id] = item;
  }
  const assignments = arrayValue(data.assignments).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const sessionId = stringValue(item.sessionId);
    const session = sessionId ? sessionsById[sessionId] : undefined;
    const date = stringValue(item.date) ?? (session ? stringValue(session.date) : undefined);
    const start = stringValue(item.start) ?? (session ? stringValue(session.start) : undefined);
    const end = stringValue(item.end) ?? (session ? stringValue(session.end) : undefined);
    if (!id || !date || !start || !end) return [];
    const center = session ? stringValue(session.title) ?? stringValue(session.centerId) : stringValue(item.center);
    return [{
      id,
      date,
      start,
      end,
      ...(sessionId ? { sessionId } : {}),
      ...(center ? { center } : {}),
      ...(stringValue(session?.kind) ? { kind: stringValue(session?.kind) } : {}),
      ...(stringValue(item.status) ? { status: stringValue(item.status) } : {})
    }];
  });
  return {
    recurringAvailability,
    exceptions,
    assignments,
    revision: parseRevision(volunteer.revision ?? data.revision),
    stale: data.stale === true
  };
}

function parseSchedule(value: unknown): AdminScheduleData {
  const data = isRecord(value) ? value : {};
  const sessions = arrayValue(data.sessions).flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    const date = stringValue(item.date);
    const start = stringValue(item.start);
    const end = stringValue(item.end);
    if (!id || !date || !start || !end) return [];
    const assignments = arrayValue(item.assignments).flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const assignmentDate = stringValue(candidate.date) ?? date;
      const assignmentStart = stringValue(candidate.start) ?? start;
      const assignmentEnd = stringValue(candidate.end) ?? end;
      return [{
        date: assignmentDate,
        start: assignmentStart,
        end: assignmentEnd,
        ...(stringValue(candidate.id) ? { id: stringValue(candidate.id) } : {}),
        ...(stringValue(candidate.volunteerId) ? { volunteerId: stringValue(candidate.volunteerId) } : {}),
        ...(stringValue(candidate.volunteerName) ? { volunteerName: stringValue(candidate.volunteerName) } : {}),
        ...(stringValue(candidate.sessionId) ? { sessionId: stringValue(candidate.sessionId) } : {}),
        ...(stringValue(candidate.center) ? { center: stringValue(candidate.center) } : {}),
        ...(stringValue(candidate.role) ? { role: stringValue(candidate.role) } : {})
      }];
    });
    return [{
      id,
      date,
      start,
      end,
      assignments,
      ...(stringValue(item.center) ? { center: stringValue(item.center) } : {}),
      ...(stringValue(item.kind) ? { kind: stringValue(item.kind) } : {}),
      ...(numberValue(item.requiredStaffCount) !== undefined ? { requiredStaffCount: numberValue(item.requiredStaffCount) } : {}),
      ...(arrayValue(item.backups).every((entry) => typeof entry === 'string') ? { backups: arrayValue(item.backups) as string[] } : {}),
      ...(numberValue(item.shortfall) !== undefined ? { shortfall: numberValue(item.shortfall) } : {}),
      ...(stringValue(item.status) ? { status: stringValue(item.status) } : {})
    }];
  });
  return {
    sessions,
    revision: parseRevision(data.revision),
    inputRevision: parseRevision(data.inputRevision),
    stale: data.stale === true,
    runStatus: stringValue(data.runStatus),
    diagnostic: stringValue(data.diagnostic)
  };
}

function parseImport(value: unknown): ImportRunData {
  const data = isRecord(value) ? value : {};
  const preview = arrayValue(data.preview).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      ...(stringValue(item.name) ? { name: stringValue(item.name) } : {}),
      ...(stringValue(item.email) ? { email: stringValue(item.email) } : {}),
      ...(stringValue(item.status) ? { status: stringValue(item.status) } : {}),
      ...(stringValue(item.sourceParticipantId) ? { sourceParticipantId: stringValue(item.sourceParticipantId) } : {})
    }];
  });
  const availabilityPreview = arrayValue(data.availabilityPreview).flatMap((item) => {
    if (!isRecord(item)) return [];
    const volunteerId = stringValue(item.volunteerId);
    if (!volunteerId) return [];
    const intervals = arrayValue(item.intervals).flatMap((interval) => {
      if (!isRecord(interval)) return [];
      const weekday = numberValue(interval.weekday);
      const start = stringValue(interval.start);
      const end = stringValue(interval.end);
      if (weekday === undefined || !start || !end) return [];
      return [{ weekday, start, end }];
    });
    return [{
      volunteerId,
      ...(stringValue(item.volunteerName) ? { volunteerName: stringValue(item.volunteerName) } : {}),
      intervals
    }];
  });
  const mappingOptions = arrayValue(data.mappingOptions).flatMap((item) => {
    if (!isRecord(item)) return [];
    const volunteerId = stringValue(item.volunteerId);
    if (!volunteerId) return [];
    return [{
      volunteerId,
      ...(stringValue(item.name) ? { name: stringValue(item.name) } : {}),
      ...(stringValue(item.email) ? { email: stringValue(item.email) } : {}),
      ...(stringValue(item.lifecycleStatus) ? { lifecycleStatus: stringValue(item.lifecycleStatus) } : {})
    }];
  });
  return {
    status: stringValue(data.status),
    resultsCode: stringValue(data.resultsCode),
    ...(stringValue(data.runId) ? { runId: stringValue(data.runId) } : {}),
    participantCount: numberValue(data.participantCount),
    matchedCount: numberValue(data.matchedCount),
    unmatchedCount: numberValue(data.unmatchedCount),
    diagnostics: arrayValue(data.diagnostics).filter((item): item is string => typeof item === 'string'),
    preview,
    availabilityPreview,
    mappingOptions,
    revision: parseRevision(data.revision),
    canPromote: data.canPromote === true
  };
}

function parseInsights(value: unknown): InsightsData {
  const data = isRecord(value) ? value : {};
  const cells = arrayValue(data.cells).flatMap((item) => {
    if (!isRecord(item)) return [];
    const weekday = numberValue(item.weekday);
    const start = stringValue(item.start);
    const end = stringValue(item.end);
    const count = numberValue(item.count);
    if (weekday === undefined || !start || !end || count === undefined) return [];
    return [{
      weekday,
      start,
      end,
      count,
      ...(arrayValue(item.volunteerNames).every((entry) => typeof entry === 'string') ? { volunteerNames: arrayValue(item.volunteerNames) as string[] } : {})
    }];
  });
  return { cells, revision: parseRevision(data.revision), stale: data.stale === true, generatedAt: stringValue(data.generatedAt) };
}

function parseCenter(value: unknown): CenterScheduleData {
  const data = isRecord(value) ? value : {};
  const candidates = arrayValue(data.candidates).flatMap((item) => {
    if (!isRecord(item)) return [];
    const weekday = numberValue(item.weekday);
    const start = stringValue(item.start);
    const end = stringValue(item.end);
    const requestedStaffCount = numberValue(item.requestedStaffCount);
    if (weekday === undefined || !start || !end || requestedStaffCount === undefined) return [];
    const candidate: CenterCandidate = { weekday, start, end, timeZone: stringValue(item.timeZone) ?? 'UTC', requestedStaffCount };
    const coverage = isRecord(item.coverage) ? item.coverage : undefined;
    const coverageCount = numberValue(item.coverageCount) ?? (coverage ? numberValue(coverage.matchingVolunteerCount) : undefined);
    const status = stringValue(item.status) ?? (coverage?.label === 'Candidate coverage' ? 'Candidate coverage' : undefined);
    const names = arrayValue(item.volunteerNames);
    const rankedNames = coverage ? arrayValue(coverage.rankedVolunteers).flatMap((entry) => isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []) : [];
    const id = stringValue(item.id);
    if (id !== undefined) candidate.id = id;
    if (coverageCount !== undefined) candidate.coverageCount = coverageCount;
    if (status !== undefined) candidate.status = status;
    if (names.length > 0 && names.every((entry) => typeof entry === 'string')) candidate.volunteerNames = names as string[];
    else if (rankedNames.length > 0) candidate.volunteerNames = rankedNames;
    return [candidate];
  });
  return { centerName: stringValue(data.centerName), candidates, revision: parseRevision(data.revision) };
}

function configFrom(value: unknown): ClientConfig {
  if (!isRecord(value)) return DEFAULT_CLIENT_CONFIG;
  const appsScriptUrl = stringValue(value.appsScriptUrl) ?? '';
  const oauthClientId = stringValue(value.oauthClientId) ?? '';
  return { appsScriptUrl, oauthClientId };
}

/**
 * The config is fetched as a document-relative path, never as '/config.json': a
 * GitHub Pages project site serves the app from /<repo>/, so a root-absolute
 * request would 404 and leave the deployment looking unconfigured.
 */
export async function loadClientConfig(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ClientConfig> {
  try {
    const response = await fetchImpl('config.json', { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!response.ok) return DEFAULT_CLIENT_CONFIG;
    return configFrom(await response.json() as unknown);
  } catch {
    return DEFAULT_CLIENT_CONFIG;
  }
}

function clear(element: HTMLElement): void {
  while (element.firstChild) element.firstChild.remove();
}

function setIdentityText(host: HTMLElement, state: IdentityState, documentRef: Document, onSignOut: () => void): void {
  clear(host);
  if (state.status === 'authenticated') {
    const label = documentRef.createElement('span');
    label.className = 'identity-label';
    label.textContent = state.profile.name ? `${state.profile.name} (${state.profile.role})` : `${state.profile.email} (${state.profile.role})`;
    host.append(label);
    const signOut = documentRef.createElement('button');
    signOut.type = 'button';
    signOut.className = 'text-button';
    signOut.textContent = 'Sign out';
    signOut.addEventListener('click', onSignOut);
    host.append(signOut);
    return;
  }
  const message = documentRef.createElement('span');
  message.className = state.status === 'unavailable' ? 'muted' : 'identity-status';
  message.textContent = state.status === 'loading' ? 'Loading sign-in…' : state.status === 'authenticating' ? 'Signing in…' : state.message ?? 'Sign in to continue.';
  host.append(message);
}

function renderNavigation(runtime: Runtime): void {
  const header = runtime.document.querySelector('header');
  if (!header) return;
  const oldNav = header.querySelector('.route-nav');
  oldNav?.remove();
  if (!runtime.profile) return;
  const nav = runtime.document.createElement('nav');
  nav.className = 'route-nav';
  nav.setAttribute('aria-label', 'Scheduling sections');
  for (const route of ROUTES[runtime.profile.role]) {
    const link = runtime.document.createElement('a');
    link.href = `#${route}`;
    link.textContent = route === 'centers' ? 'Center candidates' : route.charAt(0).toUpperCase() + route.slice(1);
    link.className = route === runtime.route ? 'active' : '';
    nav.append(link);
  }
  header.append(nav);
}

function renderError(runtime: Runtime, message: string): void {
  renderUnauthorized(runtime.app, message, runtime.document);
}

async function loadRoute(runtime: Runtime): Promise<void> {
  if (!runtime.profile || runtime.rendering) return;
  runtime.rendering = true;
  renderNavigation(runtime);
  try {
    const credential = runtime.identity.getCredential();
    if (!credential) {
      renderError(runtime, 'Your sign-in session has ended. Please sign in again.');
      return;
    }
    if (runtime.profile.role === 'volunteer') {
      const dashboard = parseDashboard(await runtime.api.volunteerDashboard(credential));
      renderVolunteerDashboard(runtime.app, dashboard, {
        onRecurringUpdate: async (intervals, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.updateRecurringAvailability(intervals, expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        },
        onExceptionCreate: async (exception, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.createAvailabilityException(exception, expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        },
        onAssignmentCancel: async (assignmentId, reason, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.cancelAssignment(assignmentId, reason, expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        }
      }, runtime.document);
    } else if (runtime.profile.role === 'administrator' && runtime.route === 'schedule') {
      const schedule = parseSchedule(await runtime.api.schedule(credential));
      renderAdminSchedule(runtime.app, schedule, {
        onRerun: async (expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.rerunSchedule(expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        }
      }, runtime.document);
    } else if (runtime.profile.role === 'administrator' && runtime.route === 'import') {
      const renderImport = (importData: ImportRunData): void => {
        const actions: AdminImportActions = {
          onPreview: async (resultsCode) => renderImport(parseImport(await runtime.api.importPreview(resultsCode, credential))),
          onPromote: async (resultsCode, expectedRevision) => {
            if (expectedRevision === undefined) throw new Error('Preview a valid import before promoting it.');
            await runtime.api.importPromote(resultsCode, expectedRevision, credential);
            await loadRouteAfterAction(runtime);
          },
          // The server saves the mapping and re-matches the staged import, so the
          // refreshed preview normally arrives with the response. Fall back to a
          // plain preview when there was nothing left to re-match.
          onMap: async (source, volunteerId) => {
            if (importData.revision === undefined) throw new Error('Preview the import before reconciling participants.');
            const response = await runtime.api.importMappingUpsert({ ...source, volunteerId }, importData.revision, credential);
            const refreshed = isRecord(response) ? response.import : undefined;
            if (isRecord(refreshed)) {
              renderImport(parseImport(refreshed));
              return;
            }
            if (importData.resultsCode) {
              renderImport(parseImport(await runtime.api.importPreview(importData.resultsCode, credential)));
              return;
            }
            renderImport(importData);
          }
        };
        renderAdminImport(runtime.app, importData, actions, importData.revision, runtime.document);
      };
      renderImport({});
    } else if (runtime.profile.role === 'administrator' && runtime.route === 'insights') {
      const insights = parseInsights(await runtime.api.insights(credential));
      renderAdminInsights(runtime.app, insights, {
        onRefresh: async (expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.refreshInsights(expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        }
      }, true, runtime.document);
    } else if ((runtime.profile.role === 'administrator' || runtime.profile.role === 'center-contact') && runtime.route === 'centers') {
      const centerData = parseCenter(await runtime.api.centerCandidate(credential));
      renderCenterSchedule(runtime.app, centerData, runtime.profile.role as ViewRole, {
        onCandidateUpdate: async (candidate, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.updateCenterCandidate(candidate, expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        },
        onCandidateConfirm: runtime.profile.role === 'administrator' ? async (candidateId, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
          await runtime.api.confirmCenterCandidate(candidateId, expectedRevision, credential);
          await loadRouteAfterAction(runtime);
        } : undefined
      }, runtime.document);
    }
  } catch (error) {
    const message = error instanceof ApiClientError && error.code === 'service_unavailable' ? 'The scheduling service is not configured for this deployment.' : 'We could not load this section. Please try again.';
    renderError(runtime, message);
  } finally {
    runtime.rendering = false;
  }
}

async function loadRouteAfterAction(runtime: Runtime): Promise<void> {
  runtime.rendering = false;
  await loadRoute(runtime);
}

function chooseRoute(runtime: Runtime): void {
  if (!runtime.profile) return;
  const requested = (globalThis.location?.hash ?? '').slice(1) as Route;
  const allowed = ROUTES[runtime.profile.role] as readonly string[];
  runtime.route = allowed.includes(requested) ? requested : ROUTES[runtime.profile.role][0];
  void loadRoute(runtime);
}

export async function boot(documentRef: Document = globalThis.document): Promise<Runtime | undefined> {
  if (!documentRef) return undefined;
  const app = documentRef.getElementById('app');
  if (!app) return undefined;
  const identityHost = documentRef.getElementById('identity');
  const loadedConfig = await loadClientConfig();
  let config = loadedConfig;
  let api: ApiClient;
  try {
    api = new ApiClient(config.appsScriptUrl);
  } catch {
    config = DEFAULT_CLIENT_CONFIG;
    api = new ApiClient();
  }
  const identity = new IdentityController(api, { oauthClientId: config.oauthClientId, buttonParent: identityHost ?? undefined });
  const runtime: Runtime = { document: documentRef, app, identityHost, config, api, identity, route: 'dashboard', rendering: false };
  identity.subscribe((state) => {
    if (identityHost) setIdentityText(identityHost, state, documentRef, () => identity.signOut());
    if (state.status === 'authenticated') {
      runtime.profile = state.profile;
      chooseRoute(runtime);
    } else if (state.status === 'signed-out' || state.status === 'unavailable') {
      runtime.profile = undefined;
      renderNavigation(runtime);
      renderError(runtime, state.message ?? 'Sign in with an authorized Google account to continue.');
    }
  });
  globalThis.addEventListener('hashchange', () => chooseRoute(runtime));
  if (!config.appsScriptUrl) {
    if (identityHost) setIdentityText(identityHost, { status: 'unavailable', message: 'This deployment has no scheduling service configured.' }, documentRef, () => identity.signOut());
    renderError(runtime, 'This static site is ready, but its scheduling service has not been configured.');
    return runtime;
  }
  await identity.initialize();
  return runtime;
}

if (typeof document !== 'undefined') {
  void boot();
}
