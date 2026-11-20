#!/usr/bin/env bash
# 用 cast 独立核对 demo.mjs 的结果（不依赖 viem）
set -e
R=logs/run-result.json
H=$(jq -r .hash $R); A=$(jq -r .alice $R); S=$(jq -r .sponsor $R); RV=$(jq -r .revokeHash $R)
echo "\$ cast rpc eth_getTransactionByHash $H | jq '{type,from,to,authorizationList}'"
cast rpc eth_getTransactionByHash $H | jq '{type,from,to,authorizationList}'
echo; echo "\$ cast receipt $H --json | jq '{status,gasUsed,effectiveGasPrice}'"
cast receipt $H --json | jq '{status,gasUsed,effectiveGasPrice}'
echo; echo "\$ cast code $A --block <type-4 所在区块>"
cast code $A --block $(cast receipt $H blockNumber)
echo; echo "\$ cast balance $A"; cast balance $A
echo; echo "\$ cast rpc eth_getTransactionByHash $RV | jq '{type,auth_address,auth_nonce}'"
cast rpc eth_getTransactionByHash $RV | jq '{type, auth_address: .authorizationList[0].address, auth_nonce: .authorizationList[0].nonce}'
echo; echo "\$ cast code $A   # 撤销后"; cast code $A
INNER=$(cast keccak demo.sponsoredbatch)
M1=$(python3 -c "print(hex(int('$INNER',16)-1))")
SLOT=$(python3 -c "print(hex(int('$(cast keccak $(cast abi-encode 'f(uint256)' $M1))',16) & ~0xff))")
echo; echo "\$ cast storage $A $SLOT   # 撤销后委托合约写入的 nonce 槽"; cast storage $A $SLOT
