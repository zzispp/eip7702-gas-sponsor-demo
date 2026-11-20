// Offline reconstruction of public byte artifacts. No RPC or broadcasting.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const provenance = require('./base-provenance.json');

function bytes(hex) {
  const clean = hex.replace(/^0x/, '');
  assert.match(clean, /^(?:[0-9a-f]{2})*$/i);
  return Buffer.from(clean, 'hex');
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hex = (data) => `0x${data.toString('hex')}`;
const word = (n) => bytes(n.toString(16).padStart(64, '0'));

function build() {
  const { creation, runtime: ref } = provenance;
  const runtime = bytes(fs.readFileSync(path.join(__dirname, '../bitget-7702-logic-v0.0.3.bytecode'), 'utf8').trim());
  assert.equal(runtime.length, ref.bytes);
  assert.equal(sha256(runtime), ref.sha256);
  const metadataOffset = runtime.length - 2 - runtime.readUInt16BE(runtime.length - 2);
  assert.deepEqual(runtime.subarray(metadataOffset), bytes(ref.metadataWithLengthTrailerHex));

  const template = Buffer.from(runtime);
  const args = creation.constructorArgs.map((address) => {
    assert.match(address, /^0x[0-9a-f]{40}$/i);
    return word(BigInt(address));
  });
  for (const { runtimeWordOffset: offset, constructorArg: arg } of creation.immutablePatches) {
    assert.equal(runtime[offset - 1], 0x7f, `expected PUSH32 at ${offset - 1}`);
    assert.deepEqual(runtime.subarray(offset, offset + 32), args[arg]);
    template.fill(0, offset, offset + 32);
  }

  const prefix = bytes(creation.initPrefixHex);
  const initcode = Buffer.concat([prefix, template, ...args]);
  assert.equal(initcode.length, creation.initcodeWithArgsBytes);
  assert.equal(sha256(initcode), creation.initcodeWithArgsSha256);

  // The outer transaction ABI envelope is distinct from what the constructor executes.
  const padding = Buffer.alloc((32 - initcode.length % 32) % 32);
  const calldata = Buffer.concat([
    bytes(creation.outerSelector), word(64), bytes(creation.outerSaltWord), word(initcode.length), initcode, padding,
  ]);
  assert.equal(calldata.length, creation.outerCalldataBytes);
  assert.equal(sha256(calldata), creation.outerCalldataSha256);
  return { runtime, template, metadataOffset, prefix, initcode, calldata };
}

const opcode = Object.fromEntries(Object.entries({
  '00': 'STOP ADD MUL SUB DIV SDIV MOD SMOD ADDMOD MULMOD EXP SIGNEXTEND',
  10: 'LT GT SLT SGT EQ ISZERO AND OR XOR NOT BYTE SHL SHR SAR',
  20: 'KECCAK256',
  30: 'ADDRESS BALANCE ORIGIN CALLER CALLVALUE CALLDATALOAD CALLDATASIZE CALLDATACOPY CODESIZE CODECOPY GASPRICE EXTCODESIZE EXTCODECOPY RETURNDATASIZE RETURNDATACOPY EXTCODEHASH',
  40: 'BLOCKHASH COINBASE TIMESTAMP NUMBER PREVRANDAO GASLIMIT CHAINID SELFBALANCE BASEFEE BLOBHASH BLOBBASEFEE',
  50: 'POP MLOAD MSTORE MSTORE8 SLOAD SSTORE JUMP JUMPI PC MSIZE GAS JUMPDEST TLOAD TSTORE MCOPY PUSH0',
  a0: 'LOG0 LOG1 LOG2 LOG3 LOG4',
  f0: 'CREATE CALL CALLCODE RETURN DELEGATECALL CREATE2',
  fa: 'STATICCALL',
  fd: 'REVERT INVALID SELFDESTRUCT',
}).flatMap(([start, names]) => names.split(' ').map((name, i) => [parseInt(start, 16) + i, name])));

function disassemble(code) {
  const lines = [];
  for (let pc = 0; pc < code.length;) {
    const start = pc;
    const op = code[pc++];
    let text = opcode[op];
    if (op >= 0x60 && op <= 0x7f) {
      const len = op - 0x5f;
      assert.ok(pc + len <= code.length, `truncated PUSH data at ${start}`);
      text = `PUSH${len} ${hex(code.subarray(pc, pc + len))}`;
      pc += len;
    } else if (op >= 0x80 && op <= 0x8f) text = `DUP${op - 0x7f}`;
    else if (op >= 0x90 && op <= 0x9f) text = `SWAP${op - 0x8f}`;
    assert.ok(text, `unrecognized opcode ${op.toString(16)} at ${start}`);
    lines.push(`${start.toString(16).padStart(4, '0')}  ${text}`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  const parts = build();
  const artifacts = {
    'creation-initcode.hex': hex(parts.initcode),
    'creation-tx-calldata.hex': hex(parts.calldata),
    'constructor.asm': `; Initcode prefix only. The runtime template starts at 0x00c6; ABI constructor arguments at 0x0b6b.\n${disassemble(parts.prefix)}`,
    'runtime.asm': `; Linear disassembly of deployed bytes (PCs in hex); does not assert reachability.\n${disassemble(parts.runtime.subarray(0, parts.metadataOffset))}\n\n; ${parts.metadataOffset.toString(16)}: CBOR metadata + length trailer, not executable instructions.\n; ${hex(parts.runtime.subarray(parts.metadataOffset))}`,
  };
  const [mode, target, ...extras] = process.argv.slice(2);
  if (mode === '--export' && target && extras.length === 0) {
    const dir = path.resolve(target);
    fs.mkdirSync(dir); // Refuse to overwrite an existing artifact directory.
    for (const [name, content] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(dir, name), `${content}\n`, { flag: 'wx' });
    }
    console.log(`Wrote ${Object.keys(artifacts).length} artifacts to ${dir}`);
  } else if (mode !== undefined) {
    throw new Error('Usage: node reconstruct-bytecode.cjs [--export NEW_DIRECTORY]');
  }
  console.log(`PASS runtime ${parts.runtime.length} B, constructor input ${parts.initcode.length} B, outer calldata ${parts.calldata.length} B; SHA-256 matches for all`);
}

module.exports = { build, disassemble, hex, provenance };
