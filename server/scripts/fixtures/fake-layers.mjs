// 테스트용 레이어 상태와 객체. 배치·블록·관망 종속 객체도 미리 보기와 적용에서 확인한다.
const layers = new Map([
  ['0', { name: '0', handle: 'D0', color: 7, protected: '기본 레이어' }],
  ['defpoints', { name: 'Defpoints', handle: 'D1', color: 7, protected: '기본 레이어' }],
  ['current', { name: 'CURRENT', handle: 'D2', color: 7, protected: '현재 레이어' }],
  ['xref|road', { name: 'XREF|ROAD', handle: 'D3', color: 7, protected: '외부참조 레이어' }],
  ['c-road-cl', { name: 'C-ROAD-CL', handle: 'D4', color: 2 }],
  ['layout-only', { name: 'LAYOUT-ONLY', handle: 'D5', color: 7 }],
  ['block-only', { name: 'BLOCK-ONLY', handle: 'D6', color: 7 }],
  ['style-only', { name: 'STYLE-ONLY', handle: 'D7', color: 7, blocked: '도면 설정에서 사용 중' }],
  ['c-pipe', { name: 'C-PIPE', handle: 'D8', color: 7 }],
  ['network', { name: 'NETWORK', handle: 'D9', color: 7 }]
]);
for (const layer of layers.values()) {
  Object.assign(layer, { locked: false, frozen: false, off: false });
}
const objects = new Map([
  ['F1', { handle: 'F1', type: 'Line', layer: 'C-ROAD-CL' }],
  ['F2', { handle: 'F2', type: 'Line', layer: 'LAYOUT-ONLY' }],
  ['F3', { handle: 'F3', type: 'Line', layer: 'BLOCK-ONLY' }],
  ['F4', { handle: 'F4', type: 'Network', layer: 'NETWORK' }],
  ['F5', { handle: 'F5', type: 'Pipe', layer: 'NETWORK' }],
  ['F6', { handle: 'F6', type: 'Structure', layer: 'C-PIPE' }],
  ['F7', { handle: 'F7', type: 'PipeLabel', layer: 'C-PIPE' }]
]);
let nextHandle = 0xE0;
const key = name => name.toLowerCase();
const state = layer => ({ color: layer.color, locked: layer.locked, frozen: layer.frozen, off: layer.off });
export const layerNames = () => [...layers.values()].map(layer => layer.name).sort();
export const layerInfo = name => layers.get(key(name));
export const layerEntities = name => [...objects.values()].filter(item => key(item.layer) === key(name));
export function blockLayer(name, blocked) {
  layers.get(key(name)).blocked = blocked;
}
export function addLayerEntity(item) {
  objects.set(item.handle, item);
}
export function restoreLayers(previous) {
  layers.clear();
  objects.clear();
  for (const layer of previous.layers) {
    layers.set(key(layer.name), layer);
  }
  for (const item of previous.objects) {
    objects.set(item.handle, item);
  }
}

function requested(params) {
  const input = params.action === 'create' ? params.create
    : params.names ?? (params.action === 'edit' ? params.edits : params.targets).map(target => target.name);
  const names = input.map(item => typeof item === 'string' ? item : item.name);
  if (new Set(names.map(key)).size !== names.length) {
    throw new Error('같은 레이어를 두 번 지정할 수 없습니다.');
  }
  return input;
}

function inventory(name) {
  const direct = layerEntities(name);
  const related = direct.some(item => item.type === 'Network') ? ['F5', 'F6', 'F7'].map(id => objects.get(id)) : [];
  const all = [...new Map([...direct, ...related.filter(Boolean)].map(item => [item.handle, item])).values()];
  const effects = [];
  if (direct.some(item => item.type === 'Network')) {
    effects.push('관망과 소속 관·구조물, 다른 레이어의 종속 라벨도 함께 삭제합니다.');
  }
  if (key(name) === 'block-only') {
    effects.push('블록 정의 변경은 이 블록의 모든 배치에 반영됩니다.');
  }
  return { objects: all, effects };
}

export function previewLayers(params) {
  if (params.action === 'edit' && !['color', 'locked', 'frozen', 'off'].some(field => params[field] !== undefined)) {
    throw new Error('바꿀 레이어 속성을 지정하세요.');
  }
  const items = requested(params).map(input => {
    const name = typeof input === 'string' ? input : input.name;
    const existing = layers.get(key(name));
    const base = { name: existing?.name ?? name, handle: existing?.handle, objects: [], effects: [] };
    if (params.action === 'create') {
      const invalid = !name.trim() || name !== name.trim() || /[<>/\\":;?*|=,\x00-\x1f]/u.test(name);
      return { ...base, name, after: state(input),
        blocked: invalid ? '올바르지 않은 이름' : existing ? '이미 있는 레이어' : undefined };
    }
    if (!existing) {
      return { ...base, blocked: '도면에 없는 레이어' };
    }
    if (params.action === 'edit') {
      const before = state(existing), after = { ...before };
      for (const field of ['color', 'locked', 'frozen', 'off']) {
        if (params[field] !== undefined) {
          after[field] = params[field];
        }
      }
      const blocked = key(name).includes('|') ? '외부참조 레이어'
        : after.frozen && key(name) === 'current' ? '현재 레이어는 동결할 수 없습니다.' : undefined;
      return { ...base, before, after, changeColor: params.color !== undefined, blocked };
    }
    const found = inventory(name);
    const blocked = existing.protected ?? existing.blocked
      ?? (found.objects.length && !params.deleteObjects ? '객체도 함께 삭제할지 질문하세요.' : undefined);
    return { ...base, before: state(existing), ...found, blocked };
  });
  return { items };
}

export function applyLayers(params) {
  if (params.action === 'edit') {
    return applyEdits(params);
  }
  const preview = previewLayers(params);
  const blocked = preview.items.find(item => item.blocked);
  if (blocked) {
    throw new Error(blocked.name + ': ' + blocked.blocked);
  }
  if (params.action === 'delete') {
    for (const target of params.targets) {
      const current = inventory(target.name).objects;
      const signature = items => items.map(item => [item.handle, item.type, item.layer].join('|')).sort();
      if (layers.get(key(target.name))?.handle !== target.handle ||
        JSON.stringify(signature(current)) !== JSON.stringify(signature(target.objects ?? []))) {
        throw new Error('레이어 또는 삭제 객체가 계획 뒤에 바뀌었습니다.');
      }
    }
  }
  const previousLayers = snapshot();
  const deleted = new Set();
  if (params.action === 'create') {
    for (const layer of params.create) {
      layers.set(key(layer.name), { ...layer, handle: (nextHandle++).toString(16).toUpperCase() });
    }
  } else {
    for (const target of params.targets) {
      for (const item of target.objects ?? []) {
        objects.delete(item.handle);
        deleted.add(item.handle);
      }
      layers.delete(key(target.name));
    }
  }
  return { previousLayers, createdLayers: params.action === 'create' ? params.create.map(layer => layer.name) : [],
    deletedLayers: params.action === 'delete' ? params.targets.map(layer => layer.name) : [], deletedObjects: deleted.size };
}

const snapshot = () => structuredClone({ layers: [...layers.values()], objects: [...objects.values()] });

function applyEdits(params) {
  for (const edit of params.edits) {
    const current = layers.get(key(edit.name));
    if (!current || current.handle !== edit.handle || JSON.stringify(state(current)) !== JSON.stringify(edit.before)) {
      throw new Error('레이어가 계획 뒤에 바뀌었습니다.');
    }
    if (edit.after.frozen && key(edit.name) === 'current') {
      throw new Error('현재 레이어는 동결할 수 없습니다.');
    }
    if (key(edit.name).includes('|')) {
      throw new Error('외부참조 레이어');
    }
  }
  const previousLayers = snapshot();
  for (const edit of params.edits) {
    Object.assign(layers.get(key(edit.name)), edit.after);
  }
  return { previousLayers, createdLayers: [], deletedLayers: [], editedLayers: params.edits.map(edit => edit.name) };
}
