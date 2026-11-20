// 手算 7702 授权哈希：keccak256(0x05 || rlp([chain_id, address, nonce]))，再与 viem 结果和签名恢复比对
import { keccak256, concat, toRlp, toHex, numberToHex, recoverAddress } from "viem";
import { hashAuthorization } from "viem/utils";
import { privateKeyToAccount } from "viem/accounts";
const alice = privateKeyToAccount("0x" + "11".repeat(32));
const auth = { chainId: 31337, address: "0x5fbdb2315678afecb367f032d93f642f64180aa3", nonce: 0 };
const h = (n) => (n === 0 ? "0x" : numberToHex(n)); // RLP 里整数 0 编码为空字节串
const rlp = toRlp([h(auth.chainId), auth.address, h(auth.nonce)]);
const manual = keccak256(concat(["0x05", rlp]));
const viemHash = hashAuthorization({ ...auth, contractAddress: auth.address });
const signed = await alice.signAuthorization({ ...auth, contractAddress: auth.address });
const rec = await recoverAddress({ hash: manual, signature: { r: signed.r, s: signed.s, yParity: signed.yParity } });
console.log("rlp([chain_id,address,nonce]) =", rlp);
console.log("msg = 0x05 || rlp            =", concat(["0x05", rlp]));
console.log("keccak256(msg) 手算          =", manual);
console.log("viem hashAuthorization       =", viemHash, manual === viemHash ? "✓ 一致" : "✗ 不一致");
console.log("ecrecover(签名)              =", rec, rec === alice.address ? "✓ 就是 Alice" : "✗");
// chain_id = 0：同一签名可在任意链生效
const rlp0 = toRlp(["0x", auth.address, "0x"]);
console.log("chain_id=0 时 rlp            =", rlp0);
