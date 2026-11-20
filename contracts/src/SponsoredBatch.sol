// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// 最小演示：EOA 通过 EIP-7702 委托到本合约后，任何人（sponsor）都可以代为提交
/// 一批调用，但每一批都必须带有 EOA 私钥对 (chainId, 账户地址, nonce, deadline, calls) 的签名。
/// 仅用于本地学习，未经审计，不要部署到主网。
contract SponsoredBatch {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    // ERC-7201 风格的命名空间存储槽，避免与以后换用的委托合约发生 storage 冲突
    // keccak256(abi.encode(uint256(keccak256("demo.sponsoredbatch")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant NONCE_SLOT =
        keccak256(abi.encode(uint256(keccak256("demo.sponsoredbatch")) - 1)) & ~bytes32(uint256(0xff));

    event Executed(uint256 indexed nonce, address indexed relayer, uint256 calls);

    error BadSignature();
    error Expired();
    error CallFailed(uint256 index, bytes reason);

    function nonce() public view returns (uint256 n) {
        bytes32 slot = NONCE_SLOT;
        assembly { n := sload(slot) }
    }

    function digest(Call[] calldata calls, uint256 n, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), n, deadline, keccak256(abi.encode(calls))));
    }

    function execute(Call[] calldata calls, uint256 deadline, bytes calldata sig) external payable {
        if (block.timestamp > deadline) revert Expired();
        uint256 n = nonce();
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest(calls, n, deadline)));
        if (_recover(h, sig) != address(this)) revert BadSignature();

        bytes32 slot = NONCE_SLOT;
        assembly { sstore(slot, add(n, 1)) }

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i, ret);
        }
        emit Executed(n, msg.sender, calls.length);
    }

    function _recover(bytes32 h, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address a = ecrecover(h, v, r, s);
        if (a == address(0)) revert BadSignature();
        return a;
    }

    receive() external payable {}
}
