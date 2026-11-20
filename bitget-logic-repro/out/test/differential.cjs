/* Offline only. Spawns its own non-forked Anvil, never takes an RPC URL. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const solc = require('solc');
const {
  AbiCoder, ContractFactory, HDNodeWallet, Interface, JsonRpcProvider, concat, getAddress, getCreateAddress, id, keccak256,
  toBeHex, toQuantity, zeroPadValue, ZeroHash,
} = require('ethers');
const { build: buildByteArtifacts, hex, provenance } = require('../reconstruct-bytecode.cjs');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const original = read('bitget-7702-logic-v0.0.3.bytecode').trim();
const admin = getAddress('0x696ada227454bd0bf38e8605ab7bacc02a293605');
const ep = getAddress('0x4337084d9e255ff0702461cf8895ce9e3b5ff108');
const impl = getAddress('0x1000000000000000000000000000000000000770');
const mnemonic = 'test test test test test test test test test test test junk';
const [owner, sponsor, platform] = [0, 1, 2].map((i) =>
  HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`));
const chainId = 31337;
const port = Number(process.env.ANVIL_PORT ?? 18545);
assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535);
const gasLimit = 3_000_000n;
const coder = AbiCoder.defaultAbiCoder();
const callArray = '(address,uint256,bytes)[]';
const verifyArgs = [callArray,'uint256','uint256','bytes','bytes'];
const extArgs = [...verifyArgs,'uint16','uint256','bytes'];
const verifySelector = '0x0db39b93';
const word = (x) => zeroPadValue(toBeHex(x), 32);
const abi = (types, args) => coder.encode(types, args);
const raw = (selector, types, args) => concat([selector, abi(types, args)]);
const withValue = (value) => ({ value: toQuantity(value) });
const addrWord = (a) => zeroPadValue(a.toLowerCase(), 32);
const replaceWord = (hex, offset, val) => `${hex.slice(0, 2 + 2 * offset)}${word(val).slice(2)}${hex.slice(2 + 2 * (offset + 32))}`;
const fail = (data) => ({ revert: data });
const ret = (data = '0x') => ({ return: data });

function compile() {
  const files = ['BitgetLogicEquiv.sol', 'test/Fixtures.sol'];
  const config = {
    language: 'Solidity',
    sources: Object.fromEntries(files.map((f) => [f, { content: read(`out/${f}`) }])),
    settings: { evmVersion: 'prague', viaIR: true, optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi','evm.bytecode.object','evm.deployedBytecode.object','storageLayout'] } } },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(config)));
  const errors = (result.errors ?? []).filter((x) => x.severity === 'error');
  if (errors.length) throw Error(errors.map((x) => x.formattedMessage).join('\n'));
  const c = { ...result.contracts[files[0]], ...result.contracts[files[1]] };
  assert.equal(c.BitgetLogicEquiv.storageLayout.storage.length, 0);
  return c;
}

async function main(rpc) {
  const c = compile();
  const bytecode = (name, deployed = true) => `0x${c[name].evm[deployed ? 'deployedBytecode' : 'bytecode'].object}`;
  const iface = (name) => new Interface(c[name].abi);
  const logicAbi = iface('BitgetLogicEquiv');
  const adminAbi = iface('LocalAdminStub');
  const epAbi = iface('EntryPointFixture');
  const fixtureAbi = iface('CallFixture');
  const logicData = (...args) => logicAbi.encodeFunctionData(...args);
  const fixtureData = (...args) => fixtureAbi.encodeFunctionData(...args);
  const ctx = owner.address;
  assert.equal(await rpc.send('eth_chainId', []), toQuantity(chainId));
  assert.equal(await rpc.send('eth_blockNumber', []), '0x0');
  const accounts = await rpc.send('eth_accounts', []);
  assert.deepEqual(accounts.slice(0, 3).map(getAddress), [ctx, sponsor.address, platform.address]);
  async function call(to, data, from = sponsor.address, value = 0n, block = 'latest') {
    try { return ret(await rpc.send('eth_call', [{ to, data, from, ...withValue(value), gas: toQuantity(gasLimit) }, block])); }
    catch (e) {
      const reverted = e.info?.error?.data ?? e.data;
      if (typeof reverted !== 'string' || !/^0x[0-9a-f]*$/i.test(reverted)) throw e;
      return fail(reverted);
    }
  }
  const balance = async (a) => BigInt(await rpc.send('eth_getBalance', [a, 'latest']));
  const txNonce = async (a) => BigInt(await rpc.send('eth_getTransactionCount', [a, 'latest']));
  const slot = (a, key) => rpc.send('eth_getStorageAt', [a, toQuantity(key), 'latest']);
  const send = async (wallet, fields) => {
    const tx = await wallet.signTransaction({
      type: 2, nonce: await txNonce(wallet.address), chainId, gasLimit,
      maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...fields,
    });
    const hash = await rpc.send('eth_sendRawTransaction', [tx]);
    const receipt = await rpc.send('eth_getTransactionReceipt', [hash]);
    assert.ok(receipt);
    return receipt;
  };
  const receiptFields = (receipt) => ({ status: receipt.status,
    logs: receipt.logs.map(({ address,topics,data }) => ({ address,topics,data })) });
  const fee = (receipt) => BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

  // Re-execute only the recovered initcode on this disposable local chain.
  // Do not send the historical factory calldata or interact with a public network.
  const artifacts = buildByteArtifacts();
  assert.equal(keccak256(hex(artifacts.initcode)), provenance.creation.initcodeWithArgsKeccak256);
  assert.equal(keccak256(original), provenance.runtime.keccak256);
  assert.equal(getCreateAddress({ from: provenance.creation.immediateCreatorBaseScan, nonce: 1 }).toLowerCase(), provenance.address);
  const beforeCreation = await rpc.send('evm_snapshot', []);
  const originalInit = hex(artifacts.initcode);
  assert.deepEqual(await call(undefined, originalInit), ret(original));
  assert.deepEqual(await call(undefined, originalInit, sponsor.address, 1n), fail('0x'));
  const originalCreation = await send(sponsor, { data: originalInit });
  assert.equal(originalCreation.status, '0x1');
  assert.equal(await rpc.send('eth_getCode', [originalCreation.contractAddress, 'latest']), original);
  assert.equal(await slot(originalCreation.contractAddress, 0n), ZeroHash);
  assert.deepEqual(await call(originalCreation.contractAddress, '0x8ce2c83a'), ret(addrWord(admin)));
  assert.deepEqual(await call(originalCreation.contractAddress, '0x94430fa5'), ret(addrWord(ep)));
  const reconstructedLogic = new ContractFactory(c.BitgetLogicEquiv.abi, bytecode('BitgetLogicEquiv', false));
  const compiledInit = await reconstructedLogic.getDeployTransaction(admin, ep);
  const reconstructedCreation = await send(sponsor, compiledInit);
  assert.equal(reconstructedCreation.status, '0x1');
  const reconstructedRuntime = await rpc.send('eth_getCode', [reconstructedCreation.contractAddress, 'latest']);
  assert.notEqual(reconstructedRuntime, '0x');
  assert.deepEqual(await call(undefined, compiledInit.data, sponsor.address, 1n), fail('0x'));
  for (const [selector, want] of [['0x8ce2c83a', admin], ['0x94430fa5', ep]]) {
    assert.deepEqual(await call(reconstructedCreation.contractAddress, selector), ret(addrWord(want)));
  }
  // Also establish constructor order away from the production addresses.
  const alternativeArgs = [sponsor.address, platform.address];
  const originalBare = originalInit.slice(0, -128);
  const alternateOriginalInit = concat([originalBare, abi(['address', 'address'], alternativeArgs)]);
  const alternateCompiledInit = await reconstructedLogic.getDeployTransaction(...alternativeArgs);
  const alternateOriginal = await send(sponsor, { data: alternateOriginalInit });
  const alternateCompiled = await send(sponsor, alternateCompiledInit);
  for (const { status, contractAddress } of [alternateOriginal, alternateCompiled]) {
    assert.equal(status, '0x1');
    assert.deepEqual(await call(contractAddress, '0x8ce2c83a'), ret(addrWord(alternativeArgs[0])));
    assert.deepEqual(await call(contractAddress, '0x94430fa5'), ret(addrWord(alternativeArgs[1])));
  }
  assert.equal(await rpc.send('evm_revert', [beforeCreation]), true);
  console.log('PASS original initcode: local CREATE + eth_call reproduce the exact runtime; payable guard and immutable getters match');
  console.log('PASS readable Solidity constructor: nonpayable, Admin then EntryPoint; original and reconstructed getters agree for two argument sets');

  const fixtureDeploy = new ContractFactory(c.CallFixture.abi, bytecode('CallFixture', false));
  const deployment = await send(sponsor, await fixtureDeploy.getDeployTransaction());
  assert.equal(deployment.status, '0x1');
  const target = getAddress(deployment.contractAddress);
  await rpc.send('anvil_setCode', [admin, bytecode('LocalAdminStub')]);
  await rpc.send('anvil_setCode', [ep, bytecode('EntryPointFixture')]);
  const snapshot = await rpc.send('evm_snapshot', []);
  const nonce0 = (1n << 230n) + 99n;
  const checkDeadline = 2_100_000_000n;
  const deadlineError = logicAbi.getError('SignatureExpired').selector;
  const badSig = adminAbi.getError('BadDualSignature').selector;
  const replayError = adminAbi.getError('NonceUsed').selector;
  const sigDigest = id('local EIP-2098 verification probe');
  const signed = owner.signingKey.sign(sigDigest);
  const usedKey = (nonce) => BigInt(keccak256(abi(['uint256','bytes32'], [nonce, keccak256(abi(['address','uint256'],[ctx,0]))])));
  const childA = [target, 17n, fixtureData('record', ['0xaabbcc'])];
  const childB = [target, 0n, fixtureData('record', ['0x9988'])];
  const badChild = [target, 0n, fixtureData('fail', [8n])];
  const emptyBadChild = [target, 0n, fixtureData('failEmpty')];
  function args(calls, nonce, deadline = checkDeadline) {
    const digest = keccak256(abi(['bytes32','uint256','address',callArray,'uint256','uint256'],
      [id('LOCAL ANVIL BITGET LOGIC DIFFERENTIAL FIXTURE'),chainId,ctx,calls,nonce,deadline]));
    return [calls, nonce, deadline, platform.signingKey.sign(digest).serialized, owner.signingKey.sign(digest).serialized];
  }
  const aggregate = (a) => logicData('aggregate', a);
  const aggregateV2 = (a) => logicData('aggregateV2', [...a, 0xbeef, 91, '0x010203']);
  const packed = (sig) => [ctx, 987n, '0x1122', '0xaabb', ZeroHash, 0, ZeroHash, '0x3344', sig];
  const userOp = (sig, missing = 0n) => logicData('validateUserOp', [packed(sig), sigDigest, missing]);
  const viaEP = (...args) => epAbi.encodeFunctionData('invoke', [ctx, userOp(...args)]);
  const valResult = (v) => ret(abi(['bytes'], [word(v)]));

  async function run(runtime) {
    await rpc.send('anvil_setCode', [impl, runtime]);
    assert.equal(await rpc.send('eth_getCode', [impl, 'latest']), runtime);
    const auth = owner.authorizeSync({ address: impl, chainId, nonce: await txNonce(ctx) });
    const set = await send(sponsor, { type: 4, to: ctx, authorizationList: [auth] });
    assert.equal(set.status, '0x1');
    assert.equal(set.type, '0x4');
    assert.equal(await rpc.send('eth_getCode', [ctx, 'latest']), `0xef0100${impl.slice(2).toLowerCase()}`);
    const ownerBalance0 = await balance(ctx);
    const epBalance0 = await balance(ep);
    const results = {};
    const seen = (label, got, want) => {
      assert.deepEqual(got, want, label);
      results[label] = got;
    };
    const at = (data, from, value) => call(ctx, data, from, value);
    const expect = async (label, data, want, from, value) => seen(label, await at(data, from, value), want);
    const V = (sig) => logicData('isValidSignature', [sigDigest, sig]);
    const S = (x) => logicData('supportsInterface', [x]);
    await expect('ENTRY_POINT()', logicData('ENTRY_POINT'), ret(addrWord(ep)));
    await expect('bgw7702Admin()', logicData('bgw7702Admin'), ret(addrWord(admin)));
    await expect('nonpayable getter', logicData('ENTRY_POINT'), fail('0x'), undefined, 1n);
    for (const x of ['0x01ffc9a7','0x150b7a02','0x4e2312e0','0x1626ba7e','0xffffffff']) {
      await expect(`ERC-165 ${x}`, S(x), ret(word(BigInt(!['0x1626ba7e','0xffffffff'].includes(x)))));
    }
    await expect('ERC-165 dirty padding', concat(['0x01ffc9a7','0x01ffc9a7','0x' + word(1n).slice(10)]), fail('0x'));
    for (const x of ['0x150b7a02','0xf23a6e61','0xbc197c81']) {
      await expect(`receiver ${x}`, x, ret(abi(['bytes4'], [x])), undefined, 1n);
    }
    await expect('receive', '0x', ret(), undefined, 1n);
    await expect('unknown selector', '0xdeadbeef', fail('0x3c10b94e'));
    await expect('short nonempty fallback', '0x15', fail('0x3c10b94e'));
    await expect('1271 compact', V(signed.compactSerialized), ret(abi(['bytes4'],['0x1626ba7e'])));
    await expect('1271 compact + trailing', V(concat([signed.compactSerialized,'0x1234'])), ret(abi(['bytes4'],['0x1626ba7e'])));
    await expect('1271 wrong signer', V(platform.signingKey.sign(sigDigest).compactSerialized), ret(abi(['bytes4'],['0xffffffff'])));
    await expect('1271 zero recovery', V(concat([ZeroHash,ZeroHash])), ret(abi(['bytes4'],['0xffffffff'])));
    await expect('1271 short signature', V(concat([ZeroHash,'0x00'])), fail('0x'));
    await expect('1271 high-s', V(concat([signed.r,word((1n << 255n) - 1n)])), fail('0xbf4bf5b8'));
    await expect('validateUserOp wrong caller', userOp(signed.compactSerialized), fail('0x85db247d'));
    seen('validateUserOp correct signer', await call(ep,viaEP(signed.compactSerialized)), valResult(0));
    seen('validateUserOp wrong signer + prefund request',
      await call(ep,viaEP(platform.signingKey.sign(sigDigest).compactSerialized,23n)), valResult(1));
    seen('validateUserOp short signature', await call(ep,viaEP('0x12')), fail('0x'));
    assert.equal((await send(sponsor,{ to: ep,data: viaEP(platform.signingKey.sign(sigDigest).compactSerialized,23n) })).status,'0x1');
    seen('prefund paid on signature mismatch', await balance(ep) - epBalance0, 23n);
    assert.equal((await send(sponsor,{to: ep,data: epAbi.encodeFunctionData('setRejectPrefund',[true])})).status,'0x1');
    seen('validateUserOp rejected prefund ignored',await call(ep,viaEP(signed.compactSerialized,23n)),valResult(0));
    assert.equal((await send(sponsor,{ to: ep,data: viaEP(signed.compactSerialized,23n) })).status,'0x1');
    seen('rejected prefund not transferred', await balance(ep) - epBalance0, 23n);
    await expect('legacy 0xf0513f6e blocks nonzero caller', raw('0xf0513f6e',verifyArgs,args([],nonce0,0n)), fail('0xddb5de5e'), ctx);
    await expect('legacy 0x3b135650 blocks nonzero caller', raw('0x3b135650',extArgs,[...args([],nonce0,0n),1,2,'0x']), fail('0xddb5de5e'));
    await expect('legacy short ABI', '0xf0513f6e', fail('0x'));
    await expect('legacy V2 short ABI', '0x3b135650', fail('0x'));
    await expect('aggregate short ABI', '0x9265bb9d', fail('0x'));
    // Make the first Call's address word noncanonical, leaving the top-level ABI intact.
    const dirtyTarget = (a) => replaceWord(a, 4 + 160 + 32 + 32, (1n << 160n) | BigInt(target));
    await expect('aggregate rejects dirty nested target',dirtyTarget(aggregate(args([childA],nonce0))),fail('0x'));
    await expect('aggregate expired before nested decode',dirtyTarget(aggregate(args([childA],nonce0,0n))),fail(deadlineError));
    await expect('legacy guard before nested decode',dirtyTarget(raw('0xf0513f6e',verifyArgs,args([childA],nonce0))),fail('0xddb5de5e'));
    await expect('aggregate expired before Admin', aggregate([[],nonce0,0,'0x','0x']), fail(deadlineError));
    await expect('aggregateV2 expired', aggregateV2(args([],nonce0,0n)), fail(deadlineError));
    const now = BigInt((await rpc.send('eth_getBlockByNumber',['latest',false])).timestamp);
    await expect('deadline equality', aggregate(args([],nonce0,now)), ret());
    const signedBatch = args([childA,childB], nonce0);
    await expect('aggregate missing platform signature', aggregate([...signedBatch.slice(0,3),'0x',signedBatch[4]]), fail(badSig));
    await expect('aggregate missing owner signature', aggregate([...signedBatch.slice(0,4),'0x']), fail(badSig), ctx);
    await expect('aggregate signature binds fixture calls', aggregate([[childB],...signedBatch.slice(1)]), fail(badSig));
    await expect('relayed aggregate return', aggregate(signedBatch), ret());
    const relayed = await send(sponsor, { to:ctx,data:aggregate(signedBatch),value:5n });
    const lowerCtx = ctx.toLowerCase();
    const recorded = (value,data) => ({ address:target.toLowerCase(),
      topics:[id('Recorded(address,uint256,bytes)'),addrWord(ctx)], data:abi(['uint256','bytes'], [value,data]) });
    seen('relayed aggregate receipt',receiptFields(relayed), {status:'0x1',logs:[recorded(17,'0xaabbcc'),recorded(0,'0x9988')]});
    seen('Admin calldata hash',await call(admin,adminAbi.encodeFunctionData('lastInputHash')),ret(keccak256(raw(verifySelector,verifyArgs,signedBatch))));
    seen('Admin CALL sender',await call(admin,adminAbi.encodeFunctionData('lastAccount')),ret(addrWord(ctx)));
    seen('stub nonce committed', await slot(admin,usedKey(nonce0)),word(1n));
    await expect('aggregate Admin rejects replay', aggregate(signedBatch),fail(replayError));
    await expect('aggregateV2 shares stub nonce scope', aggregateV2(signedBatch),fail(replayError));
    const failedBatch = args([childA,badChild],nonce0+1n);
    await expect('child revert wrapper', aggregate(failedBatch),fail(raw('0x2a64bdaf',['uint256','bytes'],[1,fixtureAbi.encodeErrorResult('TargetError',[8])])));
    await expect('empty child revert wrapper', aggregate(args([emptyBadChild],nonce0+1n)),fail(raw('0x2a64bdaf',['uint256','bytes'],[0,'0x'])));
    seen('reverted batch receipt', receiptFields(await send(sponsor,{to:ctx,data:aggregate(failedBatch),value:3n})), {status:'0x0',logs:[]});
    seen('reverted V2 has no Aggregate event', receiptFields(await send(sponsor,{to:ctx,data:aggregateV2(failedBatch)})), {status:'0x0',logs:[]});
    seen('reverted batch rolls back stub nonce', await slot(admin,usedKey(nonce0+1n)),word(0n));
    seen('reverted batch rolls back target storage',await call(target,fixtureData('count')),ret(word(2n)));
    seen('reverted batch rolls back balance transfers',await balance(ctx)-ownerBalance0,-35n);
    const v2 = args([childA],nonce0-1n); // deliberately lower unused nonce
    await expect('aggregateV2 lower unused nonce, return', aggregateV2(v2),ret(),ctx);
    const self = await send(owner,{to:ctx,data:aggregateV2(v2)});
    assert.equal(self.type,'0x2');
    assert.equal(self.from,lowerCtx);
    seen('self-paid V2 receipt + indexed Aggregate',receiptFields(self),{status:'0x1',logs:[recorded(17,'0xaabbcc'),{
      address:lowerCtx,topics:[id('Aggregate(uint16,uint256,bytes)'),word(0xbeefn)],data:abi(['uint256','bytes'],[91,'0x010203']),
    }]});
    seen('V2 forwards same five Admin args',await call(admin,adminAbi.encodeFunctionData('lastInputHash')),ret(keccak256(raw(verifySelector,verifyArgs,v2))));
    assert.ok(fee(self) > 0n);
    const ordinary = await send(owner,{to:target,data:childB[2],value:9n});
    assert.equal(ordinary.type,'0x2');
    assert.ok(fee(ordinary) > 0n);
    seen('delegated EOA ordinary type-2 to target',receiptFields(ordinary),{status:'0x1',logs:[recorded(9,'0x9988')]});
    seen('account balance excluding self-paid gas',await balance(ctx)-ownerBalance0+fee(ordinary)+fee(self),-61n);
    seen('target storage count',await call(target,fixtureData('count')),ret(word(4n)));
    seen('target storage last caller',await call(target,fixtureData('lastCaller')),ret(addrWord(ctx)));
    seen('target balance',await balance(target),43n);
    const selfV1 = await send(owner,{to:ctx,data:aggregate(args([],nonce0+3n))});
    assert.equal(selfV1.type,'0x2');
    assert.ok(fee(selfV1) > 0n);
    seen('self-paid aggregate receipt',receiptFields(selfV1),{status:'0x1',logs:[]});
    seen('self-paid aggregate consumes stub nonce',await slot(admin,usedKey(nonce0+3n)),word(1n));
    seen('delegated account slot 0',await slot(ctx,0),word(0n));
    seen('implementation slot 0',await slot(impl,0),word(0n));
    // Use correct fixture signatures in all ABI-return probes. These modes only
    // change synthetic returndata, not authentication or nonce checks.
    for (const [mode,want] of [[1,ret()],[2,fail('0x')],[3,fail('0x')],[4,ret()],[5,fail('0x')]]) {
      assert.equal((await send(sponsor,{to:admin,data:adminAbi.encodeFunctionData('setReturnMode',[mode])})).status,'0x1');
      await expect(`Admin retval mode ${mode}, aggregate`,aggregate(args([],nonce0+2n)),want);
      await expect(`Admin retval mode ${mode}, V2`,aggregateV2(args([],nonce0+2n)),want);
    }
    console.log(`  self-paid gas (informational): aggregateV2=${self.gasUsed}, ordinary=${ordinary.gasUsed}`);
    return results;
  }

  const originalBytes = Buffer.from(original.slice(2), 'hex');
  const hash = createHash('sha256').update(originalBytes).digest('hex');
  assert.equal(hash, '4ad11d6a434f311ef4e2a21f13e377622d786711fcbb1f67613ce1ec357e677c');
  const executableLength = originalBytes.length - 2 - originalBytes.readUInt16BE(originalBytes.length - 2);
  for (let pc = 0; pc < executableLength;) {
    const op = originalBytes[pc++];
    assert.ok(![0x54, 0x55, 0x5c, 0x5d].includes(op), `unexpected storage opcode at ${pc - 1}`);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  console.log(`solc ${solc.version()}, original runtime sha256: ${hash}; no SLOAD/SSTORE/TLOAD/TSTORE`);
  console.log('original:');
  const expected = await run(original);
  assert.equal(await rpc.send('evm_revert',[snapshot]), true);
  console.log('reconstruction:');
  const actual = await run(reconstructedRuntime);
  assert.deepEqual(actual, expected);
  const json = (v) => JSON.stringify(v, (_,x) => typeof x === 'bigint' ? x.toString() : x);
  for (const [label,value] of Object.entries(expected)) console.log(`PASS ${label}: ${json(value)}`);
  console.log(`${Object.keys(expected).length} named differential assertions matched (plus setup assertions).`);
}

async function start() {
  const anvil = process.env.ANVIL ?? 'anvil';
  const version = spawnSync(anvil,['--version'],{encoding:'utf8'});
  if (version.error || version.status !== 0) throw version.error ?? Error(version.stderr);
  console.log(version.stdout.trim());
  const child = spawn(anvil,['--host','127.0.0.1','--port',String(port),'--chain-id',String(chainId),
    '--hardfork','prague','--timestamp','2000000000','--mnemonic',mnemonic],{stdio:['ignore','pipe','pipe']});
  let errors = '';
  child.stderr.on('data',(d) => { errors += d; });
  let rpc;
  try {
    // Connect only after our own Anvil reports a successful bind, not to any
    // service already using the requested port.
    await new Promise((resolve,reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error(`Anvil startup timed out: ${errors}`)), 10_000);
      child.once('error',(e) => {clearTimeout(timer); reject(e);});
      child.once('exit',(code) => {clearTimeout(timer); reject(Error(`Anvil exited ${code}: ${errors}`));});
      child.stdout.on('data',(d) => {
        text = (text + d).slice(-8192);
        if (text.includes(`Listening on 127.0.0.1:${port}`)) {clearTimeout(timer); resolve();}
      });
    });
    rpc = new JsonRpcProvider(`http://127.0.0.1:${port}`, chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
    await main(rpc);
  } finally {
    rpc?.destroy();
    child.kill();
  }
}
start().catch((e) => { console.error(e); process.exitCode = 1; });
