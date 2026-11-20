// Explicit, read-only collection for the fixed Base snapshot. No wallet or signing code.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('./base-provenance.json');
const { build, hex } = require('./reconstruct-bytecode.cjs');

const base = 'https://mainnet.base.org';
const sourcify = 'https://sourcify.dev/server/v2/contract/8453';
const blockTag = `0x${logic.snapshot.blockNumber.toString(16)}`;
const fallbackSlot = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const guardSlot = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const modulesGetter = '0xcc2f845200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000032';
const address = {
  Logic: logic.address,
  Admin: logic.creation.constructorArgs[0],
  EntryPoint: logic.creation.constructorArgs[1],
};
const adminCreation = {
  txHash: '0xbbcb0958b56bfcbb15e8b9aeea82351899f77b23ac4d9ceee66a25cf245b0de7',
  immediateCreatorBaseScan: '0x291034d4a73bbfced19544d3104a99b00d521609',
};
const read = (url, extra = []) => JSON.parse(execFileSync('curl', ['-fsS', '--max-time', '25', '--retry', '1', ...extra, url], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }));
function rpc(calls) {
  const response = read(base, ['-H', 'Content-Type: application/json', '--data', JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params })))]);
  const indexed = new Map(response.map((row) => [row.id, row]));
  return calls.map(([method], id) => {
    const row = indexed.get(id);
    assert.ok(row && !row.error && row.result !== null && row.result !== undefined, `${method}: ${JSON.stringify(row)}`);
    return row.result;
  });
}
const getCode = (a) => ['eth_getCode', [a, blockTag]];
const getter = (a, data) => ['eth_call', [{ to: a, data }, blockTag]];
const tx = (h) => ['eth_getTransactionByHash', [h]];
const receipt = (h) => ['eth_getTransactionReceipt', [h]];
const account = (a) => ['eth_getTransactionCount', [a, blockTag]];
const slot = (a, key) => ['eth_getStorageAt', [a, key, blockTag]];
const nonemptyHex = (str) => {
  assert.match(str, /^0x(?:[\da-f]{2})+$/i);
  return Buffer.from(str.slice(2), 'hex');
};
const digest = (str) => ({
  bytes: nonemptyHex(str).length,
  sha256: createHash('sha256').update(nonemptyHex(str)).digest('hex'),
});
function addressWord(word) {
  assert.match(word, /^0x0{24}[\da-f]{40}$/i);
  return `0x${word.slice(-40).toLowerCase()}`;
}
const readWord = (b, i) => {
  assert.ok(i >= 0 && i + 32 <= b.length);
  const v = BigInt(hex(b.subarray(i, i + 32)));
  assert.ok(v <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(v);
};
function splitAdminInput(input) {
  const buf = nonemptyHex(input);
  assert.equal(hex(buf.subarray(0, 4)), '0x4af63f02');
  const offset = readWord(buf, 4);
  assert.equal(offset, 64);
  const size = readWord(buf, offset + 4);
  const start = offset + 36;
  assert.equal(start + Math.ceil(size / 32) * 32, buf.length);
  assert.equal(size, 7931);
  assert.ok(buf.subarray(start + size).every((x) => x === 0));
  return { initcode: hex(buf.subarray(start, start + size)), salt: hex(buf.subarray(36, 68)), offset: start };
}

function collect(target) {
  assert.ok(!fs.existsSync(target), 'Output already exists. Select a new directory.');
  const [chain, block, logicCode, adminCode, epCode, senderCreator, adminTx, adminReceipt] = rpc([
    ['eth_chainId', []], ['eth_getBlockByNumber', [blockTag, false]],
    getCode(address.Logic), getCode(address.Admin), getCode(address.EntryPoint), getter(address.EntryPoint, '0x09ccb880'),
    tx(adminCreation.txHash), receipt(adminCreation.txHash),
  ]);
  assert.equal(Number(chain), logic.chainId);
  assert.equal(block.hash, logic.snapshot.blockHash);
  assert.equal(logicCode, hex(build().runtime));
  address.SenderCreator = addressWord(senderCreator);
  const epSource = read(`${sourcify}/${address.EntryPoint}?fields=all`);
  assert.equal(epSource.address.toLowerCase(), address.EntryPoint);
  assert.equal(epSource.creationMatch, 'exact_match');
  assert.equal(epSource.runtimeMatch, 'exact_match');
  assert.equal(epSource.runtimeBytecode.onchainBytecode, epCode);
  assert.equal(epSource.creationBytecode.onchainBytecode, epSource.creationBytecode.recompiledBytecode);

  const [senderCode, epTx, epReceipt, adminNonce, senderNonce, entryPointNonce] = rpc([
    getCode(address.SenderCreator), tx(epSource.deployment.transactionHash), receipt(epSource.deployment.transactionHash),
    account(address.Admin), account(address.SenderCreator), account(address.EntryPoint),
  ]);
  assert.ok(nonemptyHex(senderCode).length > 0);
  assert.equal(adminReceipt.status, '0x1');
  assert.equal(epReceipt.status, '0x1');
  const adminInit = splitAdminInput(adminTx.input);
  const epInit = epSource.creationBytecode.onchainBytecode;
  assert.ok(epTx.input.endsWith(epInit.slice(2)), 'Verified EntryPoint initcode was not a suffix of deployment transaction');
  const epOuterPrefix = epTx.input.slice(0, epTx.input.length - epInit.length + 2);

  const runtimes = { Logic: logicCode, Admin: adminCode, EntryPoint: epCode, SenderCreator: senderCode };
  const facts = {
    chainId: logic.chainId,
    snapshot: { number: Number(block.number), hash: block.hash, stateRoot: block.stateRoot },
    contracts: Object.fromEntries(Object.entries(runtimes).map(([name, code]) => [name, { address: address[name], runtime: digest(code) }])),
    admin: {
      ...adminCreation, txFrom: adminTx.from, txTo: adminTx.to, blockNumber: Number(adminTx.blockNumber), blockHash: adminTx.blockHash,
      snapshotNonce: adminNonce, creationInput: digest(adminInit.initcode), outerCalldata: digest(adminTx.input),
      outerSelector: adminTx.input.slice(0, 10), outerSalt: adminInit.salt, creationByteOffset: adminInit.offset,
    },
    entryPoint: {
      matchId: epSource.matchId, verifiedAt: epSource.verifiedAt, compilation: epSource.compilation,
      txHash: epTx.hash, txFrom: epTx.from, txTo: epTx.to, blockNumber: Number(epTx.blockNumber), blockHash: epTx.blockHash,
      snapshotNonce: entryPointNonce, creationInput: digest(epInit), outerCalldata: digest(epTx.input), outerCalldataPrefix: epOuterPrefix,
      runtimeTransformations: epSource.runtimeBytecode.transformations,
      runtimeTransformationValues: epSource.runtimeBytecode.transformationValues,
    },
    senderCreator: { getter: '0x09ccb880', snapshotNonce: senderNonce },
  };
  const files = {
    'manifest.json': JSON.stringify(facts, null, 2),
    'Admin/creation-initcode.hex': adminInit.initcode,
    'Admin/creation-tx-calldata.hex': adminTx.input,
    'EntryPoint/creation-initcode.hex': epInit,
    'EntryPoint/creation-tx-calldata.hex': epTx.input,
    'EntryPoint/standard-json-input.json': JSON.stringify(epSource.stdJsonInput, null, 2),
    'EntryPoint/abi.json': JSON.stringify(epSource.abi, null, 2),
    'EntryPoint/storage-layout.json': JSON.stringify(epSource.storageLayout, null, 2),
    ...Object.fromEntries(Object.entries(runtimes).map(([name, code]) => [`${name}/runtime.hex`, code])),
  };
  // Persist the published source byte-for-byte; reject paths that could leave the bundle.
  const sources = Object.entries(epSource.stdJsonInput.sources);
  for (const [file, source] of sources) {
    assert.match(file, /^(?:[\w@.-]+\/)*[\w.-]+\.sol$/);
    assert.ok(file.split('/').every((part) => part !== '.' && part !== '..'));
    assert.equal(typeof source.content, 'string');
    files[`EntryPoint/src/${file}`] = Buffer.from(source.content, 'utf8');
  }
  fs.mkdirSync(target);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(target, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.isBuffer(content) ? content : `${content}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ contracts: facts.contracts, admin: facts.admin, entryPoint: { txTo: epTx.to, outerPrefix: epOuterPrefix, txFrom: epTx.from, creation: digest(epInit) }, sources: sources.length }, null, 2));
}

function collectSupport(target) {
  assert.ok(!fs.existsSync(target), 'Output already exists. Select a new directory.');
  const core = require(path.join(path.dirname(target), 'manifest.json'));
  const [block, payoutWord] = rpc([['eth_getBlockByNumber', [blockTag, false]], slot(address.Admin, '0x1')]);
  assert.equal(block.hash, logic.snapshot.blockHash);
  const receiver = addressWord(payoutWord);
  const [proxyCode, slot0, factoryCode, outerCode1, outerCode2, innerAdmin, innerLogic] = rpc([
    getCode(receiver), slot(receiver, '0x0'),
    getCode(core.entryPoint.txTo),
    ['eth_getCode', [core.admin.txTo, `0x${core.admin.blockNumber.toString(16)}`]],
    ['eth_getCode', [logic.creation.txTo, `0x${logic.creation.blockNumber.toString(16)}`]],
    ['eth_getCode', [core.admin.immediateCreatorBaseScan, `0x${core.admin.blockNumber.toString(16)}`]],
    ['eth_getCode', [logic.creation.immediateCreatorBaseScan, `0x${logic.creation.blockNumber.toString(16)}`]],
  ]);
  assert.ok(proxyCode.includes('a619486e'), 'Payout proxy no longer matches the observed selector');
  assert.equal(outerCode1, outerCode2);
  assert.equal(innerAdmin, innerLogic);
  const singleton = addressWord(slot0);
  const [singletonCode, proxyMaster, safeVersion] = rpc([getCode(singleton), getter(receiver, '0xa619486e'), getter(singleton, '0xffa1ad74')]);
  assert.equal(addressWord(proxyMaster), singleton);
  const versionBuf = nonemptyHex(safeVersion);
  const labelOffset = readWord(versionBuf, 0);
  const version = versionBuf.subarray(labelOffset + 32, labelOffset + 32 + readWord(versionBuf, labelOffset)).toString('utf8');
  const support = {
    PayoutSafeProxy: { address: receiver, code: proxyCode, blockNumber: core.snapshot.number, slot0 },
    PayoutSafeSingleton: { address: singleton, code: singletonCode, blockNumber: core.snapshot.number, version },
    EntryPointFactory: { address: core.entryPoint.txTo, code: factoryCode, blockNumber: core.snapshot.number },
    BitgetOuterFactory: { address: core.admin.txTo, code: outerCode1, blockNumbers: [core.admin.blockNumber, logic.creation.blockNumber] },
    AdminImmediateCreator: { address: core.admin.immediateCreatorBaseScan, code: innerAdmin, blockNumber: core.admin.blockNumber },
    LogicImmediateCreator: { address: logic.creation.immediateCreatorBaseScan, code: innerLogic, blockNumber: logic.creation.blockNumber },
  };
  const rows = Object.fromEntries(Object.entries(support).map(([name, { code, ...rest }]) => [name, { ...rest, runtime: digest(code) }]));
  fs.mkdirSync(target);
  for (const [name, { code }] of Object.entries(support)) {
    fs.writeFileSync(path.join(target, `${name}.runtime.hex`), `${code}\n`, { flag: 'wx' });
  }
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify({ snapshot: core.snapshot, adminSlot1: payoutWord, contracts: rows }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(rows, null, 2));
}

function collectSafeConfig(target) {
  assert.ok(!fs.existsSync(target), 'Output already exists. Select a new directory.');
  const support = require(path.join(path.dirname(target), 'manifest.json'));
  const receiver = support.contracts.PayoutSafeProxy.address;
  const [block, fallbackWord, guardWord, modules] = rpc([
    ['eth_getBlockByNumber', [blockTag, false]], slot(receiver, fallbackSlot), slot(receiver, guardSlot), getter(receiver, modulesGetter),
  ]);
  assert.equal(block.hash, logic.snapshot.blockHash);
  const handler = addressWord(fallbackWord);
  const [code] = rpc([getCode(handler)]);
  const moduleWords = nonemptyHex(modules);
  assert.equal(readWord(moduleWords, 0), 64);
  const moduleCount = readWord(moduleWords, 64);
  const next = addressWord(hex(moduleWords.subarray(32, 64)));
  const facts = { address: receiver, snapshot: support.snapshot, fallbackSlot, guardSlot, fallbackWord, guardWord, modulesGetter, modules, moduleCount, next,
    fallbackHandler: { address: handler, runtime: digest(code) } };
  const record = read(`${sourcify}/${handler}?fields=all`);
  assert.equal(record.address.toLowerCase(), handler);
  assert.equal(record.runtimeBytecode.onchainBytecode, code);
  assert.equal(record.creationMatch, 'exact_match');
  assert.equal(record.runtimeMatch, 'exact_match');
  const initcode = record.creationBytecode.onchainBytecode;
  assert.equal(initcode, record.creationBytecode.recompiledBytecode);
  const { matchId, compilation, deployment, stdJsonInput } = record;
  facts.fallbackHandler.verified = { matchId, compilation, deployment, creationInput: digest(initcode) };
  const sources = Object.entries(stdJsonInput.sources);
  for (const [file, source] of sources) {
    assert.match(file, /^(?:[\w@.-]+\/)*[\w.-]+\.sol$/);
    assert.ok(file.split('/').every((part) => part !== '.' && part !== '..'));
    assert.equal(typeof source.content, 'string');
  }
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(facts, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'runtime.hex'), `${code}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'creation-initcode.hex'), `${initcode}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(target, 'standard-json-input.json'), `${JSON.stringify(stdJsonInput, null, 2)}\n`, { flag: 'wx' });
  for (const [file, source] of sources) {
    const dest = path.join(target, 'src', file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source.content, { flag: 'wx' });
  }
  console.log(JSON.stringify(facts, null, 2));
}

function collectSafeSource(target) {
  assert.ok(!fs.existsSync(target), 'Output already exists. Select a new directory.');
  const support = require(path.join(path.dirname(target), 'manifest.json'));
  const files = {};
  const matches = {};
  for (const name of ['PayoutSafeProxy', 'PayoutSafeSingleton']) {
    const ref = support.contracts[name];
    const record = read(`${sourcify}/${ref.address}?fields=all`);
    assert.equal(record.address.toLowerCase(), ref.address);
    assert.deepEqual(digest(record.runtimeBytecode.onchainBytecode), ref.runtime);
    const { match, matchId, creationMatch, runtimeMatch, compilation, deployment } = record;
    const initcode = record.creationBytecode.onchainBytecode;
    const sources = Object.entries(record.stdJsonInput.sources);
    matches[name] = { address: ref.address, match, matchId, creationMatch, runtimeMatch, compilation, deployment, creationInput: digest(initcode), sourceCount: sources.length };
    files[`${name}/standard-json-input.json`] = JSON.stringify(record.stdJsonInput, null, 2);
    files[`${name}/creation-initcode.hex`] = initcode;
    for (const [file, source] of sources) {
      assert.match(file, /^(?:[\w@.-]+\/)*[\w.-]+\.sol$/);
      assert.ok(file.split('/').every((part) => part !== '.' && part !== '..'));
      assert.equal(typeof source.content, 'string');
      files[`${name}/src/${file}`] = Buffer.from(source.content, 'utf8');
    }
  }
  files['manifest.json'] = JSON.stringify(matches, null, 2);
  fs.mkdirSync(target);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(target, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.isBuffer(content) ? content : `${content}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(matches, null, 2));
}

const [arg, target] = process.argv.slice(2);
if (arg === '--support' && target && process.argv.length === 4) collectSupport(path.resolve(target));
else if (arg === '--safe-source' && target && process.argv.length === 4) collectSafeSource(path.resolve(target));
else if (arg === '--safe-config' && target && process.argv.length === 4) collectSafeConfig(path.resolve(target));
else if (arg && process.argv.length === 3) collect(path.resolve(arg));
else throw Error('Usage: node collect-dependencies.cjs [--support|--safe-source|--safe-config] NEW_DIRECTORY');
