# Bitget Wallet 7702 Logic — Base 复刻交付

目标：Base（chain ID `8453`）上的 `0x490aac77c960b0569c8e446ac7e12490bd44ca1d`。**该地址的原始创建输入和已部署 runtime 均已逐字节恢复。** 可读 Solidity 是行为复现，不是原始项目源码。

后续已完成 [Base 依赖复刻](dependencies/README.md)：原始 Admin、EntryPoint、SenderCreator 与收款 Safe 相关合约已独立归档和核验。本文仍聚焦 Logic 单合约。

| 产物 | 范围 | 验证方式 |
| --- | --- | --- |
| [原始 runtime](../bitget-7702-logic-v0.0.3.bytecode) · [反汇编](bytecode/runtime.asm) | 2,725 B，包括 CBOR 元数据和末尾长度字段 | `eth_getCode`：部署块 `44,201,837` 与快照块 `59,828,121` 均匹配 |
| [原始 initcode + 构造参数](bytecode/creation-initcode.hex) · [构造器反汇编](bytecode/constructor.asm) | 2,987 B | 从创建交易取出；本地 `eth_call` 与独立 `CREATE` 都产生与 Base 一致的 runtime |
| [原交易 calldata](bytecode/creation-tx-calldata.hex) · [链上证据与摘要](base-provenance.json) | 3,108 B，包含外层工厂调用、原始 initcode 和参数 | 离线重组后的 SHA-256 与 Base RPC 返回的 `input` 相同；不在主网重放 |
| [可读 Solidity](BitgetLogicEquiv.sol) · [行为说明](DIFF.md) · [测试输出](test-results.txt) | 构造器、9 个主 selector、`receive`、fallback、3 个接收回调和事件 | Anvil 本地造链测试；78 项具名 runtime 差分全部匹配，另有构造器验证 |

## 创建与部署证据

- [BaseScan 合约页](https://basescan.org/address/0x490aac77c960b0569c8e446ac7e12490bd44ca1d#code) 指向 [创建交易](https://basescan.org/tx/0x99ef0d57bddd660fdcecd9ddca9f4a19cf8e180ea76ad2cd6c9cffc6763b1068)，交易于 2026-04-03 13:10:21（UTC+8）执行成功。区块 `44,201,836` 查询得到空代码；创建块及后续快照均得到同一完整 runtime。外层交易发送到 `0xd7061474ed50293dba338eb9a3781a97cbc1b34e`，不是直接 `CREATE` 交易。BaseScan 所列内部创建者是 `0x515d7e214b1ebebd2e2899de1ad11098dccd0de3`；用该地址和 nonce `1` 按 `CREATE` 地址公式推导，结果与目标相符。公共 RPC 不提供本次完整内部轨迹，未把工厂内部调用顺序当作已验证事实。
- 外层 `0x4af63f02` 与 `deploy(bytes,bytes32)` 的 selector 相符，实际 calldata 可无损解码为该参数形状。首个动态参数含原始 initcode 和构造参数。按起始位置分段：`0x0000` 构造器指令（198 B），`0x00c6` runtime 模板（2,725 B），`0x0b6b` 两个 ABI address 字（64 B）。
- 构造参数按顺序是 Admin `0x696ada227454bd0bf38e8605ab7bacc02a293605`、EntryPoint `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`。构造器把这两个值写入待返回 runtime 的五个 `PUSH32` 立即数（Admin 三处，EntryPoint 两处），不是写到 storage。固定区块的 getter 与本地执行结果一致。
- runtime 的 Keccak-256 是 `0x64e773032629ad58a69738c7a4e2daaf75ed054ec14e2f69496c3bfce247e48a`。已复用 REA 接口提取证据 `ev_25e62b55cec9f1a78ee8013c3f067fdee48cb4f6a576b08f1c7f6f1e3e65393b`；其输入与 Base runtime SHA-256 一致，接口条目是候选推断。REA 未重新运行；链上查询、反汇编和本地执行分别提供独立观察。

## 什么不在这个地址里

- **原始源码。** 本次 BaseScan 页面显示未验证，Sourcify 对这个链 ID、地址返回 `match: null`。CBOR 指向 CID `QmbFuKoyDpSJ5ptjDChRh3itz7ydTvtkHwMbwZmYiN1eEL`，并带有 `solc` 版本字节 `00 08 1c`（0.8.28）；查询的网关未返回可验证的元数据文件。不能据此恢复原始变量名、两个未命名入口的原名、源文件内容、注释或完整编译配置，也不能断言不存在其他源码副本。
- **外部依赖。** 目标 runtime 没有 `DELEGATECALL` 或 `CALLCODE`，快照的 EIP-1967 implementation 槽为零；这是钱包账户的委托目标代码，不是指向另一套 Logic 的代理。Admin（平台签名、用户签名和 nonce 检查）与 EntryPoint 是独立合约，原始部署产物见[后续依赖复刻](dependencies/README.md)；Logic 差分中的 fixture 并不是其真实实现。历史交易、余额、其他账户状态不随代码复制。快照查询得到的 nonce 和余额仅记录在 JSON 中，未获得该区块的完整存储证明。
- **可读版的逐字节等价。** Solidity 复刻与原 runtime 在测试覆盖的输入下匹配，不能保证任意畸形 calldata、边界 gas 或外部环境都匹配。需要执行原始 EVM 语义时，以归档 bytecode 为准；即使用相同代码，换地址或链也不会复制 `address(this)`、状态和交易环境。

## 离线复验

从仓库根目录运行：

```sh
node bitget-logic-repro/out/reconstruct-bytecode.cjs
```

这个脚本仅用 Node 内置模块，校验 runtime、initcode、外层 calldata 的完整 SHA-256；可用 `--export 新目录` 重新生成四个字节码及反汇编文件，不覆盖已有目录。运行态复验见 [DIFF.md](DIFF.md#重跑)。所有执行和签名测试仅在本地 Anvil 完成。
