// 릴리스 서명 (docs/배포_설치.md "서명").
//   node scripts/release-signing.mjs keygen <비밀 키 저장 경로>   새 키 쌍. 공개 키를 저장소에 쓴다(아래 두 곳)
//   node scripts/release-signing.mjs export-public <비밀 키>       비밀 키에서 공개 키 두 파일을 다시 쓴다
//   node scripts/release-signing.mjs sign-manifest <번들 폴더>    Contents/manifest.json 에 서명 → Contents/manifest.sig
//   node scripts/release-signing.mjs sign-file <파일>             파일 전체에 서명 → <파일>.sig (중앙 서버가 확인)
//   node scripts/release-signing.mjs public-xml <비밀 키>          테스트용: 공개 키를 PowerShell용 XML로 출력
// 비밀 키는 환경 변수 MY_CIVIL3D_SIGNING_KEY(PEM 내용) 또는 MY_CIVIL3D_SIGNING_KEY_FILE(경로)로 받는다.
// 방식: RSA-3072, PKCS#1 v1.5, SHA-256 (Windows PowerShell 5.1의 RSACryptoServiceProvider가 확인할 수 있다).
// 공개 키 두 곳: scripts/release-public-key.xml (설치 프로그램), server/src/admin/releaseKey.ts (관리자 PC의 /중앙 배포)
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, target] = process.argv.slice(2);
const NL = String.fromCharCode(10);

function privateKey() {
  const pem = process.env.MY_CIVIL3D_SIGNING_KEY
    ?? (process.env.MY_CIVIL3D_SIGNING_KEY_FILE ? readFileSync(process.env.MY_CIVIL3D_SIGNING_KEY_FILE, 'utf8') : undefined);
  if (!pem) throw new Error('서명 키가 없습니다. MY_CIVIL3D_SIGNING_KEY 또는 MY_CIVIL3D_SIGNING_KEY_FILE을 설정하세요.');
  return createPrivateKey(pem);
}

const asPublic = key => key.type === 'public' ? key : createPublicKey(key);

// .NET RSAKeyValue XML (Modulus, Exponent: base64)
export function publicXml(key) {
  const jwk = asPublic(key).export({ format: 'jwk' });
  const b64 = value => Buffer.from(value, 'base64url').toString('base64');
  return `<RSAKeyValue><Modulus>${b64(jwk.n)}</Modulus><Exponent>${b64(jwk.e)}</Exponent></RSAKeyValue>`;
}

function writePublicFiles(key) {
  const publicKey = asPublic(key);
  writeFileSync(join(repo, 'scripts', 'release-public-key.xml'), publicXml(publicKey) + NL);
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(repo, 'server', 'src', 'admin', 'releaseKey.ts'),
    '// 릴리스 서명 공개 키 (scripts/release-signing.mjs 가 쓴다. 손으로 고치지 않는다).' + NL +
    `export const RELEASE_PUBLIC_KEY = ${JSON.stringify(pem)};` + NL);
}

const signBytes = (bytes, key) => sign('sha256', bytes, key).toString('base64');

if (command === 'keygen') {
  if (!target) throw new Error('형식: keygen <비밀 키 저장 경로>');
  const { privateKey: key, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  writeFileSync(target, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });   // 있으면 덮어쓰지 않는다
  writePublicFiles(publicKey);
  console.log(`비밀 키: ${target}` + NL + '공개 키: scripts/release-public-key.xml, server/src/admin/releaseKey.ts');
} else if (command === 'export-public') {
  writePublicFiles(createPrivateKey(readFileSync(target, 'utf8')));
  console.log('공개 키: scripts/release-public-key.xml, server/src/admin/releaseKey.ts');
} else if (command === 'sign-manifest') {
  const contents = join(resolve(target), 'Contents');
  writeFileSync(join(contents, 'manifest.sig'), signBytes(readFileSync(join(contents, 'manifest.json')), privateKey()) + NL, 'ascii');
  console.log('manifest 서명 완료');
} else if (command === 'sign-file') {
  writeFileSync(resolve(target) + '.sig', signBytes(readFileSync(resolve(target)), privateKey()) + NL, 'ascii');
  console.log(`서명 완료: ${target}.sig`);
} else if (command === 'public-xml') {
  console.log(publicXml(createPrivateKey(readFileSync(target, 'utf8'))));
} else {
  throw new Error('명령: keygen | export-public | sign-manifest | sign-file | public-xml');
}
