// EIP-7702 最小 gas 代付演示：Alice（ETH 余额 0）签授权 + 签一批调用，Sponsor 发 type-4 交易并付 gas。
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, encodeFunctionData,
         encodeAbiParameters, keccak256, zeroAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";

const art = (n) => JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`, "utf8"));
const Batch = art("SponsoredBatch"), USD = art("DemoUSD");
const transport = http("http://127.0.0.1:8545");
const pub = createPublicClient({ chain: foundry, transport });

// anvil 默认账户 #0 当部署者，#1 当 sponsor；Alice 用新生成的私钥，链上 ETH 余额为 0
const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const sponsor  = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const alice = privateKeyToAccount(process.env.ALICE_PK ?? generatePrivateKey());
const bob = "0x000000000000000000000000000000000000b0b0";
const wDeployer = createWalletClient({ account: deployer, chain: foundry, transport });
const wSponsor  = createWalletClient({ account: sponsor,  chain: foundry, transport });
const wAlice    = createWalletClient({ account: alice,    chain: foundry, transport });
const log = (...a) => console.log(...a);

async function deploy(a) {
  const hash = await wDeployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
const batchImpl = await deploy(Batch);
const usd = await deploy(USD);
await pub.waitForTransactionReceipt({ hash: await wDeployer.writeContract({ address: usd, abi: USD.abi, functionName: "mint", args: [alice.address, 100_000000n] }) });
const bal = (a) => pub.readContract({ address: usd, abi: USD.abi, functionName: "balanceOf", args: [a] });

log("== 0. 初始状态");
log("SponsoredBatch 实现合约:", batchImpl);
log("DemoUSD:", usd);
log("Alice:", alice.address, "ETH:", formatEther(await pub.getBalance({ address: alice.address })), "dUSD:", Number(await bal(alice.address)) / 1e6);
log("Alice code:", await pub.getCode({ address: alice.address }) ?? "0x (空，普通 EOA)");
log("Alice nonce:", await pub.getTransactionCount({ address: alice.address }));
const sponsorEth0 = await pub.getBalance({ address: sponsor.address });
log("Sponsor:", sponsor.address, "ETH:", formatEther(sponsorEth0));

log("\n== 1. Alice 自己发交易会怎样（余额 0）");
try {
  await wAlice.writeContract({ address: usd, abi: USD.abi, functionName: "transfer", args: [bob, 1n] });
  log("意外：成功了");
} catch (e) { log("失败，符合预期:", (e.shortMessage || e.message).split("\n")[0]); }

log("\n== 2. Alice 离线签两样东西（不花 gas）");
// (a) 7702 授权：把 Alice 的代码指向 batchImpl。Alice 不是交易发送方，所以 nonce 就是她当前 nonce
const authorization = await wAlice.signAuthorization({ contractAddress: batchImpl });
log("authorization:", JSON.stringify(authorization, (k, v) => typeof v === "bigint" ? v.toString() : v));
// (b) 业务签名：转 25 dUSD 给 Bob，再付 1 dUSD 给 sponsor 当手续费
const calls = [
  { to: usd, value: 0n, data: encodeFunctionData({ abi: USD.abi, functionName: "transfer", args: [bob, 25_000000n] }) },
  { to: usd, value: 0n, data: encodeFunctionData({ abi: USD.abi, functionName: "transfer", args: [sponsor.address, 1_000000n] }) },
];
const callTuple = [{ type: "tuple[]", components: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }];
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const digest = (n) => keccak256(encodeAbiParameters(
  [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
  [BigInt(foundry.id), alice.address, n, deadline, keccak256(encodeAbiParameters(callTuple, [calls]))]));
const sig = await alice.signMessage({ message: { raw: digest(0n) } });
log("batch signature:", sig.slice(0, 20) + "…");

log("\n== 3. Sponsor 发 type-4 交易：带上授权 + 调用 Alice 地址上的 execute");
const hash = await wSponsor.writeContract({
  address: alice.address, abi: Batch.abi, functionName: "execute", args: [calls, deadline, sig],
  authorizationList: [authorization],
});
const rc = await pub.waitForTransactionReceipt({ hash });
const tx = await pub.getTransaction({ hash });
const fee = rc.gasUsed * rc.effectiveGasPrice;
log("tx:", hash);
log("type:", tx.type, "| typeHex:", tx.typeHex, "| from:", tx.from, "| to:", tx.to, "| status:", rc.status);
log("authorizationList 条数:", tx.authorizationList?.length, "| 指向:", tx.authorizationList?.[0]?.address, "| auth nonce:", tx.authorizationList?.[0]?.nonce);
log("gasUsed:", rc.gasUsed, "effectiveGasPrice:", rc.effectiveGasPrice, "fee(ETH):", formatEther(fee));

log("\n== 4. 核对");
const code = await pub.getCode({ address: alice.address });
log("Alice code:", code, "| 前缀 0xef0100:", code?.startsWith("0xef0100"), "| 指向实现:", code?.toLowerCase() === ("0xef0100" + batchImpl.slice(2)).toLowerCase());
log("Alice ETH:", formatEther(await pub.getBalance({ address: alice.address })), "| Alice nonce:", await pub.getTransactionCount({ address: alice.address }));
log("dUSD  Alice:", Number(await bal(alice.address)) / 1e6, "Bob:", Number(await bal(bob)) / 1e6, "Sponsor:", Number(await bal(sponsor.address)) / 1e6);
const sponsorEth1 = await pub.getBalance({ address: sponsor.address });
log("Sponsor ETH 减少:", formatEther(sponsorEth0 - sponsorEth1), "| 等于回执 fee:", sponsorEth0 - sponsorEth1 === fee);
log("委托合约内 nonce:", await pub.readContract({ address: alice.address, abi: Batch.abi, functionName: "nonce" }));

log("\n== 5. 重放同一份签名（委托已存在，这次走普通 type-2 交易）");
try {
  await wSponsor.writeContract({ address: alice.address, abi: Batch.abi, functionName: "execute", args: [calls, deadline, sig] });
  log("意外：重放成功");
} catch (e) { log("被拒绝，符合预期:", (e.shortMessage || e.message).split("\n")[0], "错误名:", e.cause?.data?.errorName ?? e.cause?.reason ?? "?"); }

log("\n== 6. 撤销：Alice 签一个指向 0x0 的授权，仍由 sponsor 提交");
const revoke = await wAlice.signAuthorization({ contractAddress: zeroAddress });
const h2 = await wSponsor.sendTransaction({ to: alice.address, data: "0x", authorizationList: [revoke] });
const rc2 = await pub.waitForTransactionReceipt({ hash: h2 });
log("revoke tx:", h2, "status:", rc2.status, "auth nonce:", revoke.nonce);
log("Alice code:", (await pub.getCode({ address: alice.address })) ?? "0x (已清空)", "| Alice nonce:", await pub.getTransactionCount({ address: alice.address }));
log("撤销后 dUSD 仍在 Alice:", Number(await bal(alice.address)) / 1e6, "| 委托存储仍残留 nonce 槽（code 清空后读不到函数，需用 eth_getStorageAt 看）");
fs.mkdirSync("logs", { recursive: true });
fs.writeFileSync("logs/run-result.json", JSON.stringify({ batchImpl, usd, alice: alice.address, sponsor: sponsor.address, bob, hash, revokeHash: h2, fee: fee.toString() }, null, 1));
