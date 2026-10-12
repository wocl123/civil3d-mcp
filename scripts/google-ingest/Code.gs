// Private Drive intake. Deploy as USER_DEPLOYING / ANYONE_ANONYMOUS.
// Validation.gs is generated from the actual server-side validator.
const INTAKE_PROTOCOL = 1;
const INTAKE_MAX_BYTES = 2 * 1024 * 1024;
function intakeJSON(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function intakeFail(code) { const error = new Error(code); error.intakeCode = code; throw error; }
function intakeHash(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}
function intakeOne(iterator) {
  if (!iterator.hasNext()) return undefined;
  const item = iterator.next();
  if (iterator.hasNext()) intakeFail('DUPLICATE_DRIVE_NAME');
  return item;
}
function intakeAssertPrivate(item) {
  // PRIVATE excludes public/domain links but does not exclude individually granted permissions.
  if (item.getSharingAccess() !== DriveApp.Access.PRIVATE
      || item.getEditors().length || item.getViewers().length)
    intakeFail('COLLECTION_FOLDER_MUST_BE_PRIVATE');
  return item;
}
function intakeRead(folder, name) {
  intakeAssertPrivate(folder);
  const file = intakeOne(folder.getFilesByName(name));
  return file ? JSON.parse(intakeAssertPrivate(file).getBlob().getDataAsString('UTF-8')) : undefined;
}
function intakeWrite(folder, name, value) {
  intakeAssertPrivate(folder);
  const text = JSON.stringify(value);
  const file = intakeOne(folder.getFilesByName(name));
  if (file) intakeAssertPrivate(file).setContent(text); else intakeAssertPrivate(folder.createFile(name, text, MimeType.PLAIN_TEXT));
}
function intakeChild(folder, name) {
  intakeAssertPrivate(folder);
  return intakeAssertPrivate(intakeOne(folder.getFoldersByName(name)) || folder.createFolder(name));
}
function intakeRoot() {
  const id = PropertiesService.getScriptProperties().getProperty('MC_INTAKE_ROOT_ID');
  if (!id) intakeFail('ADMIN_SETUP_REQUIRED');
  const root = DriveApp.getFolderById(id);
  return intakeAssertPrivate(root);
}
// Run once, in the Apps Script editor, under the administrator's account.
// No folder is created under the public MC distribution folder.
function setupIntake() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('MC_INTAKE_ROOT_ID');
  if (!id) {
    const root = DriveApp.createFolder('MyCivil3DMcp-data');
    root.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    id = root.getId();
    props.setProperty('MC_INTAKE_ROOT_ID', id);
  }
  const root = intakeRoot();
  const info = { collectionFolder: root.getUrl(), folderName: root.getName(), webAppUrl: ScriptApp.getService().getUrl() };
  console.log(JSON.stringify(info));
  return info;
}
// Administrator editor-only audit: no HTTP route exposes permissions, IDs or files.
function auditIntakePermissions() {
  const id = PropertiesService.getScriptProperties().getProperty('MC_INTAKE_ROOT_ID');
  if (!id) intakeFail('ADMIN_SETUP_REQUIRED');
  const root = DriveApp.getFolderById(id);
  const pending = [{ folder: root, path: root.getName() }];
  const deadline = Date.now() + 90000, limit = 500;
  const result = { checked: 0, unsafe: [], truncated: false };
  const inspect = (item, path) => {
    if (result.checked >= limit || Date.now() >= deadline) { result.truncated = true; return false; }
    result.checked++;
    try { intakeAssertPrivate(item); } catch (_) { result.unsafe.push(path); }
    return true;
  };
  while (pending.length && !result.truncated) {
    const current = pending.pop();
    if (!inspect(current.folder, current.path)) break;
    const files = current.folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      if (!inspect(file, current.path + '/' + file.getName())) break;
    }
    if (result.truncated) break;
    const folders = current.folder.getFolders();
    while (folders.hasNext()) {
      if (result.checked + pending.length >= limit || Date.now() >= deadline) { result.truncated = true; break; }
      const folder = folders.next();
      pending.push({ folder, path: current.path + '/' + folder.getName() });
    }
  }
  result.safe = result.unsafe.length === 0 && !result.truncated;
  console.log(JSON.stringify(result));
  return result;
}
function doGet() {
  let ready = false;
  try { intakeRoot(); ready = true; } catch (_) {}
  return intakeJSON({ schema: 1, app: 'my-civil3d-mcp-intake', protocol: INTAKE_PROTOCOL, ready });
}
function intakeGlobalQuota(register) {
  const props = PropertiesService.getScriptProperties();
  const day = new Date().toISOString().slice(0, 10);
  let quota = JSON.parse(props.getProperty('MC_INTAKE_DAILY') || '{}');
  if (quota.day !== day) quota = { day, requests: 0, registrations: 0 };
  const limit = Number(props.getProperty('MC_INTAKE_DAILY_REQUESTS') || 5000);
  const regLimit = Number(props.getProperty('MC_INTAKE_DAILY_REGISTRATIONS') || 50);
  if (quota.requests >= limit || (register && quota.registrations >= regLimit)) intakeFail('DAILY_LIMIT');
  quota.requests++; if (register) quota.registrations++;
  props.setProperty('MC_INTAKE_DAILY', JSON.stringify(quota));
}
function intakeAccount(root, body) {
  const name = 'MyCivil3DMcp-' + body.installId;
  let folder = intakeOne(root.getFoldersByName(name));
  if (folder) intakeAssertPrivate(folder);
  let auth = folder && intakeRead(folder, '.receiver-auth.json');
  const tokenHash = intakeHash(body.token);
  let counted = false;
  if (body.action === 'register' && !auth) {
    if (folder) intakeFail('REGISTER_CONFLICT');
    intakeGlobalQuota(true);
    counted = true;
    folder = root.createFolder(name);
    intakeAssertPrivate(folder);
    // Write credentials first so a lost reply can repeat the same registration.
    auth = { schema: 1, tokenHash, blocked: false, createdAt: new Date().toISOString() };
    intakeWrite(folder, '.receiver-auth.json', auth);
  }
  if (!auth || auth.tokenHash !== tokenHash) intakeFail('AUTH_FAILED');
  const admin = intakeOne(folder.getFoldersByName('admin'));
  if (admin) intakeAssertPrivate(admin);
  const control = admin && intakeRead(admin, 'control.json');
  if (auth.blocked || control?.blocked === true) intakeFail('MEMBER_BLOCKED');
  // Registration retries obey the same per-install budget as uploads/pulls.
  const day = new Date().toISOString().slice(0, 10);
  if (auth.day !== day) { auth.day = day; auth.requests = 0; auth.bytes = 0; }
  if (auth.requests >= 500 || auth.bytes + body._bytes > 20 * 1024 * 1024) intakeFail('MEMBER_DAILY_LIMIT');
  if (!counted) intakeGlobalQuota(false);
  auth.requests++; auth.bytes += body._bytes;
  intakeWrite(folder, '.receiver-auth.json', auth);
  if (body.action === 'register') {
    intakeChild(folder, 'packages'); intakeChild(folder, 'candidates'); intakeChild(folder, 'admin');
    intakeWrite(folder, 'member.json', { schema: 1, app: 'my-civil3d-mcp', installId: body.installId,
      transport: 'web', createdAt: auth.createdAt, appVersion: /^[\w.-]{1,40}$/.test(body.appVersion || '') ? body.appVersion : undefined });
  }
  return { folder, auth };
}
function intakeHandle(body, bytes) {
  if (body?.schema !== 1 || typeof body.installId !== 'string' || typeof body.token !== 'string'
      || !/^[a-f\d]{16}$/.test(body.installId) || !/^[a-f\d]{64}$/.test(body.token)
      || !['register', 'package', 'candidates', 'pull'].includes(body.action)) intakeFail('INVALID_REQUEST');
  body._bytes = bytes;
  const root = intakeRoot();
  const { folder } = intakeAccount(root, body);
  const response = { schema: 1, ok: true, installId: body.installId };
  if (body.action === 'register') return response;
  if (body.action === 'package') {
    const checked = validPackage(body.package, body.installId);
    if (checked.records.length !== body.package.records.length) intakeFail('INVALID_RECORD');
    const digest = intakeHash(JSON.stringify(body.package));
    const packages = intakeChild(folder, 'packages'), name = checked.packageId + '.json';
    const existing = intakeRead(packages, name);
    if (existing && existing.transportSha256 !== digest) intakeFail('PACKAGE_CONFLICT');
    if (!existing) intakeWrite(packages, name, { schema: 1, packageId: checked.packageId, installId: body.installId,
      client: 'my-civil3d-mcp/web-1', createdAt: new Date().toISOString().slice(0, 13), records: checked.records, transportSha256: digest });
    return { ...response, packageId: checked.packageId, sha256: digest };
  }
  if (body.action === 'candidates') {
    const checked = validCandidates(body);
    const candidates = intakeChild(folder, 'candidates');
    checked.forEach(item => {
      const name = item.localId + '.json', existing = intakeRead(candidates, name);
      if (existing && JSON.stringify(existing) !== JSON.stringify(item)) intakeFail('CANDIDATE_CONFLICT');
      if (!existing) intakeWrite(candidates, name, item);
    });
    return { ...response, candidateIds: checked.map(item => item.localId), sha256: intakeHash(JSON.stringify(body.candidates)) };
  }
  // Only the caller's approved knowledge is returned. No package/auth file is readable by HTTP.
  const admin = intakeOne(folder.getFoldersByName('admin'));
  const official = admin && intakeRead(admin, 'official.json');
  return { ...response, ...(official ? { official } : {}) };
}
function doPost(e) {
  const raw = e?.postData?.contents;
  if (typeof raw !== 'string' || !raw || raw.length > INTAKE_MAX_BYTES
      || Number(e.contentLength || 0) > INTAKE_MAX_BYTES) return intakeJSON({ schema: 1, ok: false, code: 'REQUEST_TOO_LARGE' });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return intakeJSON({ schema: 1, ok: false, code: 'BUSY' });
  let body;
  try {
    const bytes = Utilities.newBlob(raw).getBytes().length;
    if (bytes > INTAKE_MAX_BYTES) intakeFail('REQUEST_TOO_LARGE');
    body = JSON.parse(raw);
    return intakeJSON(intakeHandle(body, bytes));
  } catch (error) {
    // Never echo input, credentials, Drive IDs or internal exceptions.
    const code = error.intakeCode || (error instanceof Invalid ? 'INVALID_DATA' : 'RETRY_LATER');
    return intakeJSON({ schema: 1, ok: false, installId: /^[a-f\d]{16}$/.test(body?.installId || '') ? body.installId : undefined, code });
  } finally { lock.releaseLock(); }
}
