import '../styles.css';
import { ApiClient, ApiClientError, type IdentityData } from './api';
import { IdentityController, type IdentityState } from './identity';
import { RouteLoader } from './route-loader';
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
  type VolunteerDashboardData
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

/** Everything a route paints, tagged so one loader can cache every route. */
type RoutePayload =
  | { route: 'dashboard'; dashboard: VolunteerDashboardData }
  | { route: 'schedule'; schedule: AdminScheduleData }
  | { route: 'import'; importRun: ImportRunData }
  | { route: 'insights'; insights: InsightsData }
  | { route: 'centers'; center: CenterScheduleData };

/**
 * Only routes whose load is a pure read are measured. The import section writes a
 * staged run when it previews, so it is not a read-only load.
 */
const MEASURED_ROUTES: Record<Route, boolean> = {
  dashboard: true,
  schedule: true,
  import: false,
  insights: true,
  centers: true
};

interface Runtime {
  document: Document;
  app: HTMLElement;
  routeStatus: HTMLElement | null;
  identityHost: HTMLElement | null;
  config: ClientConfig;
  api: ApiClient;
  identity: IdentityController;
  loader: RouteLoader<RoutePayload>;
  profile?: IdentityData;
  route: Route;
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

export function parseDashboard(value: unknown): VolunteerDashboardData {
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
    // Mutations send this global revision and the server rejects a stale one, so a
    // volunteer- or tab-scoped revision is never used as the concurrency token.
    revision: parseRevision(data.revision),
    stale: data.stale === true
  };
}

export function parseSchedule(value: unknown): AdminScheduleData {
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
      ...(stringValue(item.displayName) ? { displayName: stringValue(item.displayName) } : {}),
      ...(stringValue(item.kind) ? { kind: stringValue(item.kind) } : {}),
      ...(numberValue(item.requiredStaffCount) !== undefined ? { requiredStaffCount: numberValue(item.requiredStaffCount) } : {}),
      ...(arrayValue(item.backups).every((entry) => typeof entry === 'string') ? { backups: arrayValue(item.backups) as string[] } : {}),
      ...(numberValue(item.shortfall) !== undefined ? { shortfall: numberValue(item.shortfall) } : {}),
      ...(stringValue(item.status) ? { status: stringValue(item.status) } : {})
    }];
  });
  const excludedProposedSessions = arrayValue(data.excludedProposedSessions).flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      ...(stringValue(item.id) ? { id: stringValue(item.id) } : {}),
      ...(stringValue(item.displayName) ? { displayName: stringValue(item.displayName) } : {}),
      ...(stringValue(item.reason) ? { reason: stringValue(item.reason) } : {})
    }];
  });
  return {
    sessions,
    revision: parseRevision(data.revision),
    inputRevision: parseRevision(data.inputRevision),
    scheduleRevision: parseRevision(data.scheduleRevision),
    preview: data.preview === true,
    stale: data.stale === true,
    runStatus: stringValue(data.runStatus),
    diagnostic: stringValue(data.diagnostic),
    excludedProposedSessions
  };
}

export function parseImport(value: unknown): ImportRunData {
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

export function parseInsights(value: unknown): InsightsData {
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

export function parseCenter(value: unknown): CenterScheduleData {
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

/**
 * Announces progress or failure without ever naming an account, an identifier,
 * or payload content.
 */
function setRouteStatus(runtime: Runtime, message: string): void {
  if (runtime.routeStatus) runtime.routeStatus.textContent = message;
}

/**
 * Runs one fresh route read. Only the route name reaches the measurement, so a
 * performance entry can never carry a payload, account, or credential.
 */
async function requestRoute(runtime: Runtime, route: Route, credential: string): Promise<RoutePayload> {
  const performanceApi = MEASURED_ROUTES[route] ? globalThis.performance : undefined;
  const label = `route-load:${route}`;
  const start = `${label}:start`;
  performanceApi?.mark(start);
  try {
    return await readRoute(runtime, route, credential);
  } finally {
    if (performanceApi) {
      performanceApi.measure(label, start);
      performanceApi.clearMarks(start);
    }
  }
}

async function readRoute(runtime: Runtime, route: Route, credential: string): Promise<RoutePayload> {
  if (route === 'dashboard') return { route, dashboard: parseDashboard(await runtime.api.volunteerDashboard(credential)) };
  if (route === 'schedule') return { route, schedule: parseSchedule(await runtime.api.schedule(credential)) };
  if (route === 'insights') return { route, insights: parseInsights(await runtime.api.insights(credential)) };
  if (route === 'centers') return { route, center: parseCenter(await runtime.api.centerCandidate(credential)) };
  // The import section is a form: nothing is read from the service until an
  // administrator submits a results code, so this route has no fresh read.
  return { route: 'import', importRun: {} };
}

function paintRoute(runtime: Runtime, payload: RoutePayload, credential: string): void {
  const documentRef = runtime.document;
  // A successful mutation makes the active route's snapshot obsolete, so the
  // route is reloaded from a fresh read instead of the cached response.
  const afterMutation = async (): Promise<void> => {
    runtime.loader.invalidate(runtime.route);
    await loadRoute(runtime);
  };
  if (payload.route === 'dashboard') {
    renderVolunteerDashboard(runtime.app, payload.dashboard, {
      onRecurringUpdate: async (intervals, expectedRevision) => {
        if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
        await runtime.api.updateRecurringAvailability(intervals, expectedRevision, credential);
        await afterMutation();
      },
      onExceptionCreate: async (exception, expectedRevision) => {
        if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
        await runtime.api.createAvailabilityException(exception, expectedRevision, credential);
        await afterMutation();
      },
      onAssignmentCancel: async (assignmentId, reason, expectedRevision) => {
        if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
        await runtime.api.cancelAssignment(assignmentId, reason, expectedRevision, credential);
        await afterMutation();
      }
    }, documentRef);
    return;
  }
  if (payload.route === 'schedule') {
    renderAdminSchedule(runtime.app, payload.schedule, {
      onPreview: async () => {
        renderAdminSchedule(runtime.app, parseSchedule(await runtime.api.previewSchedule(credential)), {}, documentRef);
      },
      onPublish: async (expectedRevision) => {
        if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
        await runtime.api.rerunSchedule(expectedRevision, credential);
        await afterMutation();
      }
    }, documentRef);
    return;
  }
  if (payload.route === 'import') {
    const renderImport = (importData: ImportRunData): void => {
      const actions: AdminImportActions = {
        onPreview: async (resultsCode) => renderImport(parseImport(await runtime.api.importPreview(resultsCode, credential))),
        onPromote: async (resultsCode, expectedRevision) => {
          if (expectedRevision === undefined) throw new Error('Preview a valid import before promoting it.');
          await runtime.api.importPromote(resultsCode, expectedRevision, credential);
          await afterMutation();
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
      renderAdminImport(runtime.app, importData, actions, importData.revision, documentRef);
    };
    renderImport(payload.importRun);
    return;
  }
  if (payload.route === 'insights') {
    renderAdminInsights(runtime.app, payload.insights, {
      onRefresh: async (expectedRevision) => {
        if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
        await runtime.api.refreshInsights(expectedRevision, credential);
        await afterMutation();
      }
    }, true, documentRef);
    return;
  }
  const role = runtime.profile?.role;
  if (role !== 'administrator' && role !== 'center-contact') return;
  renderCenterSchedule(runtime.app, payload.center, role, {
    onCandidateUpdate: async (candidate, expectedRevision) => {
      if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
      await runtime.api.updateCenterCandidate(candidate, expectedRevision, credential);
      await afterMutation();
    },
    onCandidateConfirm: role === 'administrator' ? async (candidateId, expectedRevision) => {
      if (expectedRevision === undefined) throw new Error('The current revision is unavailable; reload and try again.');
      await runtime.api.confirmCenterCandidate(candidateId, expectedRevision, credential);
      await afterMutation();
    } : undefined
  }, documentRef);
}

/**
 * Paints the cached snapshot for the route immediately when one exists, then
 * confirms it with a fresh read. A failed refresh keeps the displayed data; a
 * failed first load uses the existing error surface instead.
 */
async function loadRoute(runtime: Runtime): Promise<void> {
  const route = runtime.route;
  renderNavigation(runtime);
  if (!runtime.profile) return;
  const credential = runtime.identity.getCredential();
  if (!credential) {
    renderError(runtime, 'Your sign-in session has ended. Please sign in again.');
    return;
  }
  const cached = runtime.loader.cached(route);
  let failure: unknown;
  try {
    if (cached) {
      paintRoute(runtime, cached, credential);
      setRouteStatus(runtime, 'Showing saved data while we check for updates…');
    } else {
      setRouteStatus(runtime, 'Loading…');
    }
    const result = await runtime.loader.load(route);
    if (runtime.route !== route || result.status === 'discarded') return;
    if (result.status === 'fresh') {
      paintRoute(runtime, result.data, credential);
      setRouteStatus(runtime, '');
      return;
    }
    failure = result.error;
  } catch (error) {
    failure = error;
  }
  if (cached) {
    setRouteStatus(runtime, 'We could not refresh this section. Showing the last loaded data.');
    return;
  }
  renderError(runtime, failure instanceof ApiClientError && failure.code === 'service_unavailable'
    ? 'The scheduling service is not configured for this deployment.'
    : 'We could not load this section. Please try again.');
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
  const loader = new RouteLoader<RoutePayload>({
    read: (request) => {
      const credential = runtime.identity.getCredential();
      if (!credential) throw new Error('The sign-in session ended before this section could be read.');
      return requestRoute(runtime, request.route as Route, credential);
    }
  });
  const runtime: Runtime = { document: documentRef, app, routeStatus: documentRef.getElementById('route-status'), identityHost, config, api, identity, loader, route: 'dashboard' };
  identity.subscribe((state) => {
    if (identityHost) setIdentityText(identityHost, state, documentRef, () => identity.signOut());
    if (state.status === 'authenticated') {
      runtime.profile = state.profile;
      // Snapshots are scoped to the authenticated email and role, so a different
      // account, a different role, or a sign-out discards every one of them.
      runtime.loader.setIdentity({ email: state.profile.email, role: state.profile.role });
      chooseRoute(runtime);
    } else if (state.status === 'signed-out' || state.status === 'unavailable') {
      runtime.profile = undefined;
      runtime.loader.setIdentity(undefined);
      setRouteStatus(runtime, '');
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
