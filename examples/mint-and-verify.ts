/**
 * Example: Mint an agent token and verify it.
 *
 * Run with: npx tsx examples/mint-and-verify.ts
 */
import * as jose from 'jose';

// --- Identity Service side ---

// Generate the IS key pair (done once, stored securely)
const { privateKey, publicKey } = await jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
const kid = 'is_key_2024_03';

// Build JWKS for publication
const publicJwk = await jose.exportJWK(publicKey);
const jwks = jose.createLocalJWKSet({
  keys: [{ ...publicJwk, kid, use: 'sig' }],
});

// Mint a token for an agent
const mid = 'master_id_abc123';
const aid = 'agt_7f3k9m2x';
const now = Math.floor(Date.now() / 1000);

const token = await new jose.SignJWT({
  mid,
  aid,
  budget: { usd: 5.0 },
  bind: { ip: null, task: 'task_xyz', parent_aid: null },
  delegation: { allowed: false, max_depth: 0 },
})
  .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
  .setIssuer('https://identity.example.com')
  .setSubject(aid)
  .setAudience('*')
  .setIssuedAt(now)
  .setExpirationTime(now + 3600) // 1 hour
  .setJti(`tok_${Date.now()}`)
  .sign(privateKey);

console.log('=== Minted Agent Token ===');
console.log(token);
console.log();

// --- Resource Provider side ---

// Verify the token (using the cached JWKS)
try {
  const { payload, protectedHeader } = await jose.jwtVerify(token, jwks, {
    algorithms: ['EdDSA'],
  });

  console.log('=== Verified Token ===');
  console.log('Header:', protectedHeader);
  console.log('Payload:', JSON.stringify(payload, null, 2));
} catch (err) {
  console.error('Verification failed:', err);
}
