import { createHash } from 'node:crypto';

let objects = [];
export const civilSnapshot = () => structuredClone(objects);
export const restoreCivil = value => { objects = structuredClone(value); };
export const civilObjects = () => structuredClone(objects);

export function listNetworks({ nameContains = '', offset = 0, limit = 50 }) {
  const all = objects.filter(item => item.operation === 'network.fixture'
    && item.name.toLowerCase().includes(nameContains.toLowerCase()));
  return { total: all.length, offset, items: structuredClone(all.slice(offset, offset + limit)), hasMore: offset + limit < all.length };
}

export function previewCivil(request) {
  if (request.operation === 'network.delete') {
    const matches = objects.filter(item => item.operation === 'network.fixture' && (request.nameContains
      ? item.name.toLowerCase().includes(request.nameContains.toLowerCase())
      : (request.networks ?? [request.network]).some(key => key === item.name || key === item.handle)));
    if (!matches.length) throw new Error('Network was not found.');
    const normalized = { operation: 'network.delete', networks: matches.map(item => item.handle) };
    return { request: normalized, summary: `관망 ${matches.length}개 삭제`,
      details: matches.map(item => `${item.name}: 관 ${item.pipes}개, 구조물 ${item.structures}개 삭제`),
      fingerprint: createHash('sha256').update(JSON.stringify(matches)).digest('hex'), kind: 'delete' };
  }
  const operation = request.operation;
  const target = objects.find(item => item.name === request.surface || item.name === request.profile);
  if (operation.endsWith('.create') && objects.some(item => item.name === request.name)) {
    throw new Error('name already exists');
  }
  if (operation === 'surface.delete' && objects.some(item => item.surface === request.surface)) {
    throw new Error('dependent profile exists');
  }
  if (operation === 'profile.create' && request.type === 'surface' && !objects.some(item => item.name === request.surface)) {
    throw new Error('Surface was not found.');
  }
  if (operation.endsWith('.edit') || operation.endsWith('.delete')) {
    if (!target) throw new Error('Object was not found.');
  }
  const summary = `${operation}: ${request.name ?? request.surface ?? request.profile ?? request.action}`;
  const details = [JSON.stringify(request)];
  const fingerprint = createHash('sha256').update(JSON.stringify(request) + JSON.stringify(target ?? null)).digest('hex');
  return { request: structuredClone(request), summary, details, fingerprint,
    kind: operation.endsWith('.create') ? 'create' : operation.endsWith('.delete') ? 'delete' : 'change' };
}

export function applyCivil({ plan }) {
  const current = previewCivil(plan.request);
  if (current.fingerprint !== plan.fingerprint) throw new Error('Changed since plan.');
  const previousCivil = civilSnapshot();
  const request = plan.request;
  const target = objects.find(item => item.name === request.surface || item.name === request.profile);
  if (request.operation.endsWith('.create')) {
    objects.push({ ...structuredClone(request), handle: (500 + objects.length).toString(16) });
  } else if (request.operation === 'network.delete') {
    objects = objects.filter(item => !request.networks.includes(item.handle));
  } else if (request.operation.endsWith('.delete')) {
    objects = objects.filter(item => item !== target);
  } else if (request.operation.endsWith('.edit')) {
    Object.assign(target, request, { name: request.newName ?? target.name });
  }
  const undoAvailable = request.operation === 'drawing.display'
    ? ['isolate', 'hide', 'restore'].includes(request.action) : undefined;
  return { previousCivil, operation: request.operation, affected: request.name ?? target?.name, undoAvailable };
}
