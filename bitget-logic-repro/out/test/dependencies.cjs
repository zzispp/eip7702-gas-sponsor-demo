/* Verifies public deployed code. Default: isolated Anvil, no network beyond loopback. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { JsonRpcProvider, getCreateAddress, getCreate2Address, keccak256 } = require('ethers');
const solc = require('solc');
const { build: buildLogic, hex, provenance: logic } = require('../reconstruct-bytecode.cjs');

const root = path.resolve(__dirname, '../dependencies');
const main = require(path.join(root, 'manifest.json'));
const support = require(path.join(root, 'support/manifest.json'));
const safeConfig = require(path.join(root, 'support/safe-config/manifest.json'));
const safeSources = require(path.join(root, 'support/verified/manifest.json'));
const safeConfigDir = 'support/safe-config';
const safeSourceDir = 'support/verified';
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').trim();
const coreRuntime = (name) => read(`${name}/runtime.hex`);
const helperRuntime = (name) => read(`support/${name}.runtime.hex`);
const adminInit = () => read('Admin/creation-initcode.hex');
const epInit = () => read('EntryPoint/creation-initcode.hex');
const addr = (name) => main.contracts[name].address;
const helper = (name) => support.contracts[name].address;

function digest(str) {
  assert.match(str, /^0x(?:[\da-f]{2})+$/i);
  const b = Buffer.from(str.slice(2), 'hex');
  return { bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
}

function verifyArchive() {
  assert.deepEqual(support.snapshot, main.snapshot);
  assert.deepEqual(safeConfig.snapshot, main.snapshot);
  assert.equal(main.snapshot.hash, logic.snapshot.blockHash);
  for (const [name, ref] of Object.entries(main.contracts)) assert.deepEqual(digest(coreRuntime(name)), ref.runtime, name);
  for (const [name, ref] of Object.entries(support.contracts)) assert.deepEqual(digest(helperRuntime(name)), ref.runtime, name);
  assert.equal(hex(buildLogic().runtime), coreRuntime('Logic'));
  assert.deepEqual(digest(adminInit()), main.admin.creationInput);
  assert.deepEqual(digest(read('Admin/creation-tx-calldata.hex')), main.admin.outerCalldata);
  assert.deepEqual(digest(epInit()), main.entryPoint.creationInput);
  assert.deepEqual(digest(read('EntryPoint/creation-tx-calldata.hex')), main.entryPoint.outerCalldata);
  assert.deepEqual(digest(read(`${safeConfigDir}/runtime.hex`)), safeConfig.fallbackHandler.runtime);
  for (const [dir, ref] of [
    [`${safeSourceDir}/PayoutSafeProxy`, safeSources.PayoutSafeProxy],
    [`${safeSourceDir}/PayoutSafeSingleton`, safeSources.PayoutSafeSingleton],
    [safeConfigDir, safeConfig.fallbackHandler.verified],
  ]) {
    assert.deepEqual(digest(read(`${dir}/creation-initcode.hex`)), ref.creationInput);
    checkSourceFiles(dir, JSON.parse(read(`${dir}/standard-json-input.json`)));
  }
  console.log('PASS 11 captured runtimes, archived deployment inputs and Safe source mirrors checked');
}

function checkSourceFiles(dir, input) {
  for (const [file, source] of Object.entries(input.sources)) {
    // Do not trim; source bytes are part of the compiler metadata commitment.
    assert.equal(fs.readFileSync(path.join(root, dir, 'src', file), 'utf8'), source.content, file);
  }
}

function compileVerifiedEntryPoint() {
  const input = JSON.parse(read('EntryPoint/standard-json-input.json'));
  checkSourceFiles('EntryPoint', input);
  assert.ok(solc.version().startsWith(main.entryPoint.compilation.compilerVersion));
  input.settings.outputSelection = {
    'contracts/core/EntryPoint.sol': { EntryPoint: ['evm.bytecode.object'] },
    'contracts/core/SenderCreator.sol': { SenderCreator: ['evm.bytecode.object'] },
  };
  const result = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (result.errors || []).filter(({ severity }) => severity === 'error');
  assert.equal(errors.length, 0, errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const creation = (name) => '0x' + result.contracts[`contracts/core/${name}.sol`][name].evm.bytecode.object;
  assert.equal(creation('EntryPoint'), epInit(), 'Recompiled original EntryPoint initcode');
  const childInit = creation('SenderCreator');
  assert.ok(epInit().includes(childInit.slice(2)), 'SenderCreator initcode is embedded in EntryPoint initcode');
  const childFile = path.join(root, 'SenderCreator/creation-initcode.hex');
  if (fs.existsSync(childFile)) assert.equal(read('SenderCreator/creation-initcode.hex'), childInit);
  console.log('PASS solc rebuild of 31 verified sources matches EntryPoint creation input and embeds SenderCreator creation bytes');
  return childInit;
}

async function verifyRuntime(rpc, block) {
  for (const [name, ref] of Object.entries(main.contracts)) {
    assert.equal(await rpc.send('eth_getCode', [ref.address, block]), coreRuntime(name), `${name} runtime`);
  }
  const getter = (to, data) => rpc.send('eth_call', [{ to, data }, block]);
  const address = (word) => `0x${word.slice(-40)}`;
  assert.equal(address(await getter(addr('Logic'), '0x8ce2c83a')), addr('Admin'));
  assert.equal(address(await getter(addr('Logic'), '0x94430fa5')), addr('EntryPoint'));
  assert.equal(address(await getter(addr('EntryPoint'), main.senderCreator.getter)), addr('SenderCreator'));
  assert.equal(address(await getter(addr('SenderCreator'), '0xb0d691fe')), addr('EntryPoint'));
}

async function verifyLocal(rpc) {
  assert.equal(await rpc.send('eth_blockNumber', []), '0x0');
  const [sender] = await rpc.send('eth_accounts', []);
  assert.ok(sender);
  const send = async (to, data) => {
    const tx = await rpc.send('eth_sendTransaction', [{ from: sender, to, data, gas: '0x1312d00' }]);
    const receipt = await rpc.send('eth_getTransactionReceipt', [tx]);
    assert.equal(receipt?.status, '0x1', `local creation for ${to}`);
    return receipt;
  };
  const epFactory = helper('EntryPointFactory');
  const salt = main.entryPoint.outerCalldataPrefix;
  const entryPointInput = read('EntryPoint/creation-tx-calldata.hex');
  assert.equal(entryPointInput, salt + epInit().slice(2));
  assert.equal(getCreate2Address(epFactory, salt, keccak256(epInit())).toLowerCase(), addr('EntryPoint'));
  assert.equal(getCreateAddress({ from: addr('EntryPoint'), nonce: 1 }).toLowerCase(), addr('SenderCreator'));
  await rpc.send('anvil_setCode', [epFactory, helperRuntime('EntryPointFactory')]);
  await send(epFactory, entryPointInput);
  assert.equal(await rpc.send('eth_getCode', [addr('EntryPoint'), 'latest']), coreRuntime('EntryPoint'));
  assert.equal(await rpc.send('eth_getCode', [addr('SenderCreator'), 'latest']), coreRuntime('SenderCreator'));
  console.log('PASS original deterministic factory deploys exact EntryPoint and SenderCreator at their Base addresses');

  // Minimal isolated CREATE adapter: copy calldata, then CREATE(0, data, size).
  // This supplies the historical immediate creator and nonce but does not
  // claim to replay Bitget's outer factory or historical production state.
  const createHelper = '0x365f5f37365f5ff05f5260205ff3';
  const pairs = [
    ['Admin', helper('AdminImmediateCreator'), adminInit()],
    ['Logic', helper('LogicImmediateCreator'), hex(buildLogic().initcode)],
  ];
  for (const [name, creator, init] of pairs) {
    assert.equal(getCreateAddress({ from: creator, nonce: 1 }).toLowerCase(), addr(name));
    await rpc.send('anvil_setCode', [creator, createHelper]);
    await rpc.send('anvil_setNonce', [creator, '0x1']);
    await send(creator, init);
    assert.equal(await rpc.send('eth_getCode', [addr(name), 'latest']), coreRuntime(name));
    console.log(`PASS original ${name} initcode deploys exact runtime at the Base address`);
  }
  await verifyRuntime(rpc, 'latest');
  console.log('PASS the four exact runtimes link through their original getter addresses');

  // These public Safe constructor inputs do not initialize production owners or balances.
  for (const [label, dir, runtime] of [
    ['Safe proxy', `${safeSourceDir}/PayoutSafeProxy`, helperRuntime('PayoutSafeProxy')],
    ['Safe singleton', `${safeSourceDir}/PayoutSafeSingleton`, helperRuntime('PayoutSafeSingleton')],
    ['Safe fallback handler', safeConfigDir, read(`${safeConfigDir}/runtime.hex`)],
  ]) {
    const { contractAddress } = await send(undefined, read(`${dir}/creation-initcode.hex`));
    assert.ok(contractAddress);
    assert.equal(await rpc.send('eth_getCode', [contractAddress, 'latest']), runtime, label);
  }
  console.log('PASS original Safe proxy, singleton and fallback handler initcodes produce exact runtimes');
}

async function verifyFork(rpc) {
  const tag = `0x${main.snapshot.number.toString(16)}`;
  assert.equal((await rpc.send('eth_getBlockByNumber', [tag, false])).hash, main.snapshot.hash);
  await verifyRuntime(rpc, tag);
  for (const name of ['PayoutSafeProxy', 'PayoutSafeSingleton']) {
    assert.equal(await rpc.send('eth_getCode', [helper(name), tag]), helperRuntime(name));
  }
  assert.equal(await rpc.send('eth_getStorageAt', [addr('Admin'), '0x1', tag]), support.adminSlot1);
  assert.equal(await rpc.send('eth_getStorageAt', [helper('PayoutSafeProxy'), '0x0', tag]), support.contracts.PayoutSafeProxy.slot0);
  assert.equal(await rpc.send('eth_getCode', [safeConfig.fallbackHandler.address, tag]), read(`${safeConfigDir}/runtime.hex`));
  for (const [slot, word] of [[safeConfig.fallbackSlot, safeConfig.fallbackWord], [safeConfig.guardSlot, safeConfig.guardWord]]) {
    assert.equal(await rpc.send('eth_getStorageAt', [safeConfig.address, slot, tag]), word);
  }
  assert.equal(await rpc.send('eth_call', [{ to: safeConfig.address, data: safeConfig.modulesGetter }, tag]), safeConfig.modules);
  console.log('PASS fixed-block Base fork: seven exact runtime images, four getter links and selected Admin/Safe configuration; no transactions');
}

async function start() {
  const mode = process.argv[2];
  assert.ok(process.argv.length <= 3 && [undefined, '--fork', '--export-child'].includes(mode));
  const fork = mode === '--fork';
  verifyArchive();
  const childInit = fork ? null : compileVerifiedEntryPoint();
  const port = Number(process.env.ANVIL_DEP_PORT ?? 18547);
  assert.ok(Number.isInteger(port) && port > 1023 && port <= 65535);
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(main.chainId)];
  if (fork) args.push('--fork-url', 'https://mainnet.base.org', '--fork-block-number', String(main.snapshot.number), '--no-storage-caching');
  else args.push('--hardfork', 'prague');
  const child = spawn(process.env.ANVIL || 'anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '', rpc;
  child.stderr.on('data', (d) => { errors = (errors + d).slice(-8192); });
  try {
    await new Promise((resolve, reject) => {
      let stdout = '';
      const fail = (e) => { clearTimeout(timer); reject(e); };
      const timer = setTimeout(() => fail(Error(`Anvil could not start: ${errors}`)), 20_000);
      child.once('error', fail);
      child.once('exit', (code) => fail(Error(`Anvil exited ${code}: ${errors}`)));
      child.stdout.on('data', (d) => {
        stdout = (stdout + d).slice(-8192);
        if (stdout.includes(`Listening on 127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
      });
    });
    rpc = new JsonRpcProvider(`http://127.0.0.1:${port}`, main.chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
    assert.equal(Number(await rpc.send('eth_chainId', [])), main.chainId);
    await (fork ? verifyFork(rpc) : verifyLocal(rpc));
    if (mode === '--export-child') fs.writeFileSync(path.join(root, 'SenderCreator/creation-initcode.hex'), `${childInit}\n`, { flag: 'wx' });
  } finally {
    rpc?.destroy();
    child.kill();
  }
}

start().catch((err) => { console.error(err.shortMessage || err.message); process.exitCode = 1; });
