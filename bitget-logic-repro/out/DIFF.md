# Bitget Wallet 7702 Logic v0.0.3 — 本地差分报告

**结论：78 项具名差分断言全部匹配，覆盖 9 个主分发入口；构造器另行验证通过。** 这是对随附 **Logic runtime** 的有限行为复现，不是对真实 Admin、真实 EntryPoint 或全部输入的等价证明。差分测试未使用主网 RPC、fork、真实用户地址或真实签名；另用只读 Base RPC 取得的字节级证据见 [复刻交付](README.md)。

## 方法与证据

- 基准：`../bitget-7702-logic-v0.0.3.bytecode` 的 2,725 字节 runtime，解码后 SHA-256 为 `4ad11d6a434f311ef4e2a21f13e377622d786711fcbb1f67613ce1ec357e677c`。工作区已有 REA JSON 与该摘要一致；本机重跑 REA 因 macOS arm64 不在该 EVM provider 支持范围内而未执行。下面的静态核对来自对本地 runtime 的独立反汇编，不把 REA 的 ABI 候选当作已验证 ABI。
- 运行：Anvil `1.5.1`、Prague、chain ID `31337`，只监听 `127.0.0.1`。两轮从同一链快照开始，只替换同一合成实现地址上的 runtime；用 Anvil 默认账户签发真实本地 type-4 授权，将账户委托给该地址，再用 `eth_call` 与签名交易测试。固定 Admin / EntryPoint 地址上通过 `anvil_setCode` 装入**本地 fixtures**，不加载真实合约。编译为 solc `0.8.28`、`viaIR: true`、optimizer `runs: 200`、`evmVersion: prague`。
- 对照内容：原始返回字节和 revert bytes、交易状态、日志 `address/topics/data`、目标与测试 Admin 的选定状态、余额变化。交易哈希、绝对余额与 gas 不做相等要求。逐项输出在 [`test-results.txt`](test-results.txt)，测试程序在 [`test/differential.cjs`](test/differential.cjs)。
- 构造器：Base 创建交易中的原始 2,987 B initcode（含参数）独立跑过本地 `eth_call` 和 `CREATE`，返回的 runtime 与链上逐字节一致。可读版也接收 `constructor(address admin_, address entryPoint_)`，两者均验证拒绝附带 ETH 的创建请求。另用两个测试账户地址验证参数位置，避免仅查验生产地址时把 getter 写死。

## 入口对照

| 选择器 | 原版与复现匹配的行为 | 范围 |
|---|---|---|
| `0x9265bb9d` `aggregate` | 原样传递 `Call[] / nonce / deadline / signerSig / ownerSig`；成功返回 `0x`，无 Logic 自身事件；子调用失败见下。测试覆盖代付及自行付费。 | Anvil + 反汇编 |
| `0x6b47a02c` `aggregateV2` | 发送同样的五个 Admin 参数；执行成功后发 `Aggregate(uint16 indexed businessType, uint256 businessAmount, bytes extraData)`；失败时无保留日志。 | Anvil + 反汇编 |
| `0xf0513f6e` / `0x3b135650` | 通过顶层 ABI 校验后，非零 caller 得到 `0xddb5de5e`；坏的顶层 ABI 数据先空 revert。 | 非零 caller：Anvil；零 caller 分支（deadline、执行、后一入口发 V2 事件）：仅静态跟踪，未交易验证 |
| `0x8ce2c83a` `bgw7702Admin()` | 返回 `0x696ada227454bd0bf38e8605ab7bacc02a293605`。 | Anvil + 反汇编 |
| `0x94430fa5` `ENTRY_POINT()` | 返回 `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`；附带价值调用空 revert。 | Anvil + 反汇编 |
| `0x19822f7c` `validateUserOp` | 非 EntryPoint caller → `0x85db247d`；经本地 EntryPoint fixture 调用，签名匹配返回 `0`，不匹配返回 `1`；有 `missingFunds` 时尝试转给 EntryPoint，即使验签不匹配；转账失败不覆盖验签结果。未测试真实 `handleOps`。 | Anvil + 反汇编 |
| `0x1626ba7e` `isValidSignature` | 用前两个字作紧凑 ECDSA `r,vs`，比较恢复地址与账户自身；可有尾随字节；匹配返回 `0x1626ba7e`，不匹配/恢复失败返回 `0xffffffff`；短于 64 字节空 revert，high-s 为 `0xbf4bf5b8`。 | Anvil + 反汇编 |
| `0x01ffc9a7` `supportsInterface` | `0x01ffc9a7`、`0x150b7a02`、`0x4e2312e0` 为真；`0x1626ba7e`、`0xffffffff` 为假；非规范 `bytes4` padding 空 revert。 | Anvil + 反汇编 |
| `receive` / fallback | 空 calldata 可收款；三个接收回调字面 selector `0x150b7a02`、`0xf23a6e61`、`0xbc197c81` 各返回 ABI 编码的自身 selector；其他未识别的非空 calldata → `0x3c10b94e`。 | Anvil + 反汇编；回调不计入九个主入口 |

## `aggregate`：deadline、双签与状态

1. **期限由 Logic 检查。** 顶层 ABI 校验后，`block.timestamp > deadline` 才报 `0x0819bdcd`，等于期限可通过。在样本中，过期错误也早于内部 `Call` 元素的解码错误和 Admin 校验错误。参考 PC `0x0146–0x015c` / `0x0241–0x025c`。
2. **双签与 nonce 交给 Admin。** Logic 用零 ETH 的普通 `CALL` 调硬编码 Admin 的 `0x0db39b93`，Admin 的 `msg.sender` 是**委托账户**，不是外层 relayer。fixture 记录的 `keccak256(msg.data)` 与五参数 ABI 编码完全一致（V1/V2 都验证）。原版 (`CALL` PC `0x01af` / `0x02b1`) 原样透传 Admin revert，成功时解码规范 `bool`，但不按布尔值分支：让已通过 fixture 双签和 nonce 校验的调用分别返回 0/1、短响应、非规范 bool 和带尾随字节的响应，两版行为相同。这只说明 Logic 的调用约定，不证明真实 Admin 会返回哪些值。
3. **批量调用按顺序执行，整批回滚。** Logic 转发各项 `target/value/data`；不使用成功子调用的返回值（测试目标成功但返回 ABI `false`）。子调用失败的准确字节为 `0x2a64bdaf || abi.encode(uint256(index), bytes(childRevertData))`，下标从 0 开始；这与 **Admin revert 原样透传** 不同。测试覆盖空/非空子调用错误、日志顺序、前序子调用发生后回滚的目标存储、余额及 fixture nonce。参考 PC `0x09a8–0x0a6e`。
4. **事件与存储。** V2 topic0 为 `0x530010b66ee62af2a793b05fb0b9bf0e9b70b8750985979823d1a55e339c4082`，topic1 为补零的 `uint16`，`data = abi.encode(uint256,bytes)`，日志归属委托账户，出现在目标日志之后。原 runtime 的指令扫描无 `SLOAD/SSTORE/TLOAD/TSTORE`，复现也未声明存储；本地账户与实现 slot 0 保持零。fixture 测过大 nonce、较低但未用 nonce、重复 nonce、跨 V1/V2 重复、缺其中任一签名和失败回滚。**这些是对 Logic 与同一 fixture 的联合验证，不是对真实 Admin nonce 算法或槽位的鉴定。**

## 自付 gas 会被挡住吗？

**不会。** 本地实际签发了两类普通 type-2 交易：

- 委托后的 EOA 直接发给测试目标：目标看到 EOA 是 caller，交易成功，EOA 自付 gas。这条路径不进入自己的 Logic，自然不经过 Logic 的 deadline 或双签。
- EOA 发给自己并调 `aggregate` 或 `aggregateV2`：合格的 fixture 双签、nonce 与 deadline 下均成功，EOA 自付 gas；缺 owner 签名的自调用也验证了会被 fixture 拒绝。**自付 gas 不会跳过批量入口的验签。**

## 未证实与差异

- Solidity 变量名、内部函数名、注释及未知入口的用途均为分析者推断。两个未知 selector 通过 fallback 精确分发，不编造 ABI 名称。旧逆向笔记把 `0x6edaef2f` 当成最终错误码；它是立即数，左移 `0xe1` 后的**实际返回**是 `0xddb5de5e`。7 个命名入口 + 2 个 raw selector 不包含三个回调分支。
- 真实 Admin 的 EIP-712 domain/typehash、签名格式及管理规则、暂停状态、nonce 作用域/布局与精确错误未复现。本地 stub 的 digest、签名约定、存储与可控返回值只为验证接口边界，不可用于生产。未测试真实 EntryPoint、零地址 caller 分支的运行态或真实业务目标合约。
- 不是字节码级等价。有限样本的 ABI 检查匹配；未穷尽畸形偏移、超大数据、紧 gas、重入及其他环境差异。例如自付 V2 样例耗气原版 **93,560**、复现 **93,059**，故不能承诺 gas 等价。普通 type-2 直接至目标的样例两版均为 **31,409**。

## 重跑

将 Anvil `1.5.1` 置于 PATH（或设置 `ANVIL` 为该二进制路径）。脚本不接收外部 RPC URL；默认端口 `18545`，冲突时可设 `ANVIL_PORT`。`npm ci` 只安装测试依赖；依赖就绪后测试不需要外部网络。

```sh
npm ci --ignore-scripts --prefix out/test
npm test --prefix out/test
```
