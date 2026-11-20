# EIP-7702 gas 代付本地 demo

用本地 Anvil 演示：**Alice 的 ETH 余额为 0**，她只离线签 7702 授权和一批调用；**Sponsor 发 type-4 交易并付 gas**，替她转出测试稳定币。随后演示同一份签名被拒绝（重放保护），以及 Alice 再签一个指向 `0x0` 的授权来撤销委托。

本仓库只用于本地学习。合约未经审计，**不要部署到主网**。

## 依赖

- [Foundry](https://book.getfoundry.sh/getting-started/installation)（`anvil`、`forge`、`cast`）
- Node.js 18+（演示脚本用 [viem](https://viem.sh/)）
- 可选：`jq`（跑 `verify.sh` 时用 `cast` 独立核对结果）

## 测试私钥

脚本里写死的两把私钥是 **Anvil 默认账户**，也是 Foundry 公开文档里的测试钥，不是任何人的主网钱包：

| 角色 | Anvil 账户 | 地址 | 私钥 |
| --- | --- | --- | --- |
| 部署者 | `#0` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| Sponsor | `#1` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |

Alice 默认在每次运行时用 `generatePrivateKey()` 临时生成，链上 ETH 为 0。如需固定 Alice，可设置环境变量 `ALICE_PK`（仍然只应使用测试钥）。

## 怎么跑

在**仓库根目录**执行：

```bash
# 终端 1：启动本地链（默认会打印上面两把测试钥）
anvil

# 终端 2
npm install
cd contracts && forge build && cd ..
node demo.mjs
```

可选核对（需 Anvil 仍在运行，且已安装 `jq`）：

```bash
bash verify.sh
node authhash.mjs   # 手算 7702 授权哈希，并与 viem 对照
```

`demo.mjs` 会把本次地址与交易哈希写到本仓库的 `logs/run-result.json`（该目录已被 `.gitignore` 忽略，不会提交）。`verify.sh` 从这个文件读取哈希。

## 跑出来会看到什么

`demo.mjs` 按步骤打印：

1. **Alice 自己发交易失败**（余额 0，付不起 gas）。
2. Alice 离线签 7702 授权（把代码指向 `SponsoredBatch`）以及一批调用的签名：转 25 dUSD 给 Bob，再付 1 dUSD 给 Sponsor。
3. **Sponsor 发出 type-4 交易**（`type` / `typeHex` 为 `0x04`），`from` 是 Sponsor，`to` 是 Alice，`authorizationList` 指向实现合约。回执里的 gas 费由 Sponsor 支付；Alice 的 ETH 仍为 0，但账户 code 变为 `0xef0100 || 实现地址`。
4. dUSD 余额变化符合预期；委托合约内的 `nonce` 变为 1。
5. **重放同一份签名失败**（nonce 已递增）。
6. **撤销**：Alice 签一个指向 `0x0` 的授权，仍由 Sponsor 提交；之后 Alice 的 code 被清空。代币余额还在，委托存储槽里的 nonce 可能残留（code 清空后要用 `eth_getStorageAt` 才能看到）。

## 关于存储槽域名盐

`SponsoredBatch` 用 ERC-7201 风格的命名空间槽存放 nonce，盐字符串是 `demo.sponsoredbatch`。这只是本地演示用的域名盐，用来降低以后换委托实现时的 storage 冲突，不是对外服务的域名，也不绑定任何账户。

若你改了这个字符串，`verify.sh` 里用于计算槽位的 `cast keccak demo.sponsoredbatch` 需要一起改。

## Bitget Wallet 7702 Logic 行为复现

[`bitget-logic-repro/`](bitget-logic-repro/out/README.md) 是 Bitget Wallet 7702 Logic v0.0.3（Base `0x490aac77c960b0569c8e446ac7e12490bd44ca1d`）的行为复现，不是官方源码。目录中包含链上字节码归档。差分测试使用本地 mock Admin 与 EntryPoint fixture，不是 Bitget 的真实签名服务。
