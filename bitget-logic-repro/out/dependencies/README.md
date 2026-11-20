# Bitget Wallet 7702 Logic：Base 依赖复刻

**在固定范围内，7 个运行相关合约的原始创建代码均已在本地执行，生成的 runtime 与 Base 逐字节一致。** 另外归档了 4 个部署工厂/中间创建者的 runtime。Base 快照区块为 `59,828,121`（2026-11-20 14:26:39 UTC+8），区块哈希和 state root 见 [`manifest.json`](manifest.json)。这不是 Bitget Wallet 整款产品的原始源码交付。

| 合约 | Base 地址 | 字节级复验 | 可读源码 |
| --- | --- | --- | --- |
| 7702 Logic | `0x490aac77c960b0569c8e446ac7e12490bd44ca1d` | [2,725 B runtime](Logic/runtime.hex)；用[原 initcode](../bytecode/creation-initcode.hex)在原地址重建 | [Solidity 行为复刻](../BitgetLogicEquiv.sol)，不是原始源码 |
| BGW7702Admin | `0x696ada227454bd0bf38e8605ab7bacc02a293605` | [7,931 B initcode](Admin/creation-initcode.hex) → 原地址 [6,369 B runtime](Admin/runtime.hex) | 无已取得的验证源码；没有把测试 stub 当作 Admin 实现 |
| EntryPoint 0.8.0 | `0x4337084d9e255ff0702461cf8895ce9e3b5ff108` | [24,175 B initcode](EntryPoint/creation-initcode.hex) → 原地址 [21,738 B runtime](EntryPoint/runtime.hex) | [Sourcify 编译输入](EntryPoint/standard-json-input.json)含 31 个源文件；本地编译与原 initcode 完全一致 |
| SenderCreator | `0x449ed7c3e6fee6a97311d4b55475df59c44add33` | [1,269 B initcode](SenderCreator/creation-initcode.hex) → 原地址 [1,217 B runtime](SenderCreator/runtime.hex) | [源码](EntryPoint/src/contracts/core/SenderCreator.sol)在 EntryPoint 编译输入中；源码编译出的创建码与嵌入 EntryPoint 的一致 |
| Admin 收款 Safe 代理 | `0xdc6d85360827fcdb68d7db579bb7dfb6c8ec1c36` | [518 B 创建输入](support/verified/PayoutSafeProxy/creation-initcode.hex) → [171 B runtime](support/PayoutSafeProxy.runtime.hex) | [已验证编译输入](support/verified/PayoutSafeProxy/standard-json-input.json)；Sourcify `match`，不能据此声称元数据也匹配 |
| Safe `GnosisSafeL2` 1.3.0 实现 | `0xfb1bffc9d739b8d520daf37df666da4c687191ea` | [23,841 B initcode](support/verified/PayoutSafeSingleton/creation-initcode.hex) → [23,800 B runtime](support/PayoutSafeSingleton.runtime.hex) | [已验证编译输入](support/verified/PayoutSafeSingleton/standard-json-input.json)；Sourcify `exact_match` |
| Safe `CompatibilityFallbackHandler` | `0x017062a1de2fe6b99be3d9d37841fed19f573804` | [5,524 B initcode](support/safe-config/creation-initcode.hex) → [5,492 B runtime](support/safe-config/runtime.hex) | [已验证编译输入](support/safe-config/standard-json-input.json)；Sourcify `exact_match` |

## 已确认的依赖

```text
7702 Logic
├─ Admin（构造器 immutable；普通外部 CALL）
│  └─ 收款 Safe 代理（Admin slot 1，快照配置，可变）
│     ├─ GnosisSafeL2（Safe slot 0）
│     └─ CompatibilityFallbackHandler（Safe 的专用 fallback slot）
└─ EntryPoint（构造器 immutable；也作为 validateUserOp 的 caller）
   └─ SenderCreator（EntryPoint 构造器创建；senderCreator() 返回其地址）
```

- Admin 的 `CALL` 在 PC `0x05e2` 将目标从 slot 1 取出；不是 Logic 硬编码的第三个地址。Admin 还有代币操作相关外呼（例如 `balanceOf(address)`，PC `0x0e82`），这里不把动态传入的代币当成固定依赖。Safe 的 guard 槽为零、模块查询返回空且指向终止哨兵；fallback handler 非零，以[配置档案](support/safe-config/manifest.json)为准。
- [四个部署辅助 runtime](support/manifest.json)：EntryPoint 的 `CREATE2` 工厂、Bitget 外层工厂、Admin 与 Logic 各自的直接创建者。最后两个地址 runtime 相同。Bitget 外层和直接创建者按各自部署块归档，与运行相关的七个地址不混计。没有声称重新构建了这四个辅助合约的源码或完整历史状态。
- 本地用**实际工厂代码**部署 EntryPoint；该构造器连同 SenderCreator 一起生成正确 runtime。Admin 与 Logic 用极小本地 CREATE 适配器，在历史直接创建者的地址及 nonce `1` 下执行原 initcode，得到相同地址与代码；**不是**重演 Bitget 外层工厂交易。Safe 的三份创建输入在本地以测试账户部署、核对返回 bytecode；这不是复现生产地址生成过程。它们在生产原地址上的 bytecode 与快照配置由 fork 独立读验。
- Admin 的原始部署资料位于 [`Admin/`](Admin/)，另有[构造器反汇编](Admin/constructor.asm)与[运行码反汇编](Admin/runtime.asm)。运行码尾部元数据含 solc 版本字节 `00 08 1c`，IPFS CID 是 `QmRXUW3XvPcYjtTb7JQS1KQjQSdCqmZsEJzB4BMf5Jwdmz`。BaseScan 未显示验证源码，Sourcify 未命中，尝试的公开 IPFS 网关也未返回可验证的元数据。能执行原始 Admin bytecode 不等同于恢复其 Solidity 源码和编译工程。

## 可复验的范围与未覆盖项

- **原代码**：7 份创建输入本地执行后都逐字节匹配；11 份归档 runtime 通过长度和 SHA-256 核验。EntryPoint/SenderCreator 额外通过 solc 0.8.28 原始编译输入复建。Safe 源码匹配等级来自 Sourcify；此处另行执行的是原始创建输入，未声称本机用 solc 0.7.6 复建。
- **生产状态**：固定区块 Base fork 通过 7 份 runtime、4 个 getter 链接及 Admin/Safe 指定配置槽检查；fork 按需读取 Base 状态，不是完整状态离线导出。未验证所有 nonce、签名人集合、历史交易、存储槽或业务分支，也未复制私钥、签名服务或生产权限。
- **不是一个有限的“所有合约”集合**：`aggregate` 的 `Call[]` 目标、EntryPoint 的用户账户/工厂/paymaster/aggregator，以及 Safe 交易目标均由输入选择。钱包前端、后端、代付服务、链下签名逻辑不包含在这些 EVM 字节码里。要验证一笔具体钱包业务，需要指定交易哈希和区块，按那笔交易的实际路径另建清单。

## 运行

默认仅启动本地 Anvil（已验证 1.5.1，监听 `127.0.0.1:18547`），不会联网。测试依赖沿用 `out/test/package-lock.json`；如未安装，先 `npm ci --ignore-scripts --prefix bitget-logic-repro/out/test`。将 `anvil` 加入 PATH 或设置环境变量 `ANVIL`。

```sh
node bitget-logic-repro/out/test/dependencies.cjs
node bitget-logic-repro/out/test/dependencies.cjs --fork
```

`--fork` 使用固定的 Base 公共 RPC 和区块号，只读检查，不发交易。两个命令均在测试结束时关闭自己启动的节点。见 [`verification.txt`](verification.txt)。收集脚本 [`../collect-dependencies.cjs`](../collect-dependencies.cjs) 只读获取链上产物和 Sourcify 字段，输出目录必须不存在。
