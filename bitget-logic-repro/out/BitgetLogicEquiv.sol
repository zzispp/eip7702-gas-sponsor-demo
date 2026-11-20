// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

// Analyst reconstruction of the supplied v0.0.3 runtime, not original source.
struct Call {
    address target;
    uint256 value;
    bytes data;
}

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface IBitget7702Admin {
    function verifySignatures(
        Call[] calldata calls, uint256 nonce, uint256 deadline, bytes calldata signerSig, bytes calldata ownerSig
    ) external returns (bool);
}

contract BitgetLogicEquiv {
    address public immutable ENTRY_POINT;
    address public immutable bgw7702Admin;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    error SignatureExpired();
    event Aggregate(uint16 indexed businessType, uint256 businessAmount, bytes extraData);

    // Order recovered from the historical creation input: Admin, then EntryPoint.
    constructor(address admin_, address entryPoint_) {
        bgw7702Admin = admin_;
        ENTRY_POINT = entryPoint_;
    }

    function aggregate(
        Call[] calldata calls, uint256 nonce, uint256 deadline, bytes calldata signerSig, bytes calldata ownerSig
    ) external payable {
        _verify(calls, nonce, deadline, signerSig, ownerSig);
        _executeCalls(calls);
    }

    function aggregateV2(
        Call[] calldata calls, uint256 nonce, uint256 deadline, bytes calldata signerSig, bytes calldata ownerSig,
        uint16 businessType, uint256 businessAmount, bytes calldata extraData
    ) external payable {
        _verify(calls, nonce, deadline, signerSig, ownerSig);
        _executeCalls(calls);
        emit Aggregate(businessType, businessAmount, extraData);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        return _signedByAccount(digest, signature) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds)
        external returns (uint256 validationData)
    {
        if (msg.sender != ENTRY_POINT) _revert4(0x85db247d);
        validationData = _signedByAccount(opHash, op.signature) ? 0 : 1;
        if (missingFunds != 0) {
            // Failure of the prefund transfer does not replace the signature result.
            (bool ok,) = payable(msg.sender).call{value: missingFunds}("");
            if (!ok) return validationData;
        }
    }

    receive() external payable {}

    // The unnamed selectors use raw dispatch. Keep calldata slices lazy so nested
    // Call tuple validation is not moved ahead of the original guard.
    fallback(bytes calldata input) external payable returns (bytes memory) {
        bytes4 selector = msg.sig;
        if (selector == 0xf0513f6e) {
            (Call[] calldata calls, uint256 deadline) = _legacyArgs(false);
            _checkLegacyCaller();
            _checkDeadline(deadline);
            _executeCalls(calls);
            return "";
        }
        if (selector == 0x3b135650) {
            (Call[] calldata calls, uint256 deadline) = _legacyArgs(true);
            _checkLegacyCaller();
            _checkDeadline(deadline);
            (uint16 businessType, uint256 businessAmount, bytes calldata extraData) = _legacyEventArgs();
            _executeCalls(calls);
            emit Aggregate(businessType, businessAmount, extraData);
            return "";
        }
        if (input.length >= 4 && (selector == 0xbc197c81 || selector == 0xf23a6e61 || selector == 0x150b7a02)) {
            return abi.encode(selector);
        }
        _revert4(0x3c10b94e);
    }

    function _checkLegacyCaller() private view {
        if (msg.sender != address(0)) _revert4(0xddb5de5e);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert SignatureExpired();
    }

    function _verify(
        Call[] calldata calls, uint256 nonce, uint256 deadline, bytes calldata signerSig, bytes calldata ownerSig
    ) private {
        _checkDeadline(deadline);
        bytes memory payload = abi.encodeCall(IBitget7702Admin.verifySignatures, (calls, nonce, deadline, signerSig, ownerSig));
        address admin = bgw7702Admin;
        // Match the runtime's external CALL and ABI bool decoding. Admin vetoes
        // by reverting; the decoded bool value itself is not branched on here.
        assembly ("memory-safe") {
            let ok := call(gas(), admin, 0, add(payload, 0x20), mload(payload), 0, 0x20)
            if iszero(ok) {
                let p := mload(0x40)
                returndatacopy(p, 0, returndatasize())
                revert(p, returndatasize())
            }
            if or(lt(returndatasize(), 0x20), gt(mload(0), 1)) { revert(0, 0) }
        }
    }

    function _executeCalls(Call[] calldata calls) private {
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            (bool ok, bytes memory result) = c.target.call{value: c.value}(c.data);
            if (!ok) {
                bytes memory failure = abi.encodeWithSelector(bytes4(0x2a64bdaf), i, result);
                assembly ("memory-safe") { revert(add(failure, 32), mload(failure)) }
            }
        }
    }

    function _signedByAccount(bytes32 digest, bytes calldata signature) private view returns (bool) {
        // The runtime consumes the first two words (EIP-2098 r, vs), tolerating
        // trailing bytes. Invalid recovery and nonmatching signers return false.
        bytes32 r;
        uint256 vs;
        assembly ("memory-safe") {
            if lt(signature.length, 64) { revert(0, 0) }
            r := calldataload(signature.offset)
            vs := calldataload(add(signature.offset, 32))
        }
        bytes32 s = bytes32(vs & (type(uint256).max >> 1));
        if (uint256(s) > HALF_ORDER) _revert4(0xbf4bf5b8);
        return ecrecover(digest, uint8(27 + (vs >> 255)), r, s) == address(this);
    }

    function _legacyArgs(bool extended) private pure returns (Call[] calldata calls, uint256 deadline) {
        assembly ("memory-safe") {
            let size := calldatasize()
            let head := 160
            if extended { head := 256 }
            if lt(size, add(4, head)) { revert(0, 0) }
            function tail(pos) -> start, length {
                let off := calldataload(pos)
                if or(gt(off, 0xffffffffffffffff), gt(add(off, 36), calldatasize())) { revert(0, 0) }
                start := add(off, 36)
                length := calldataload(sub(start, 32))
                if gt(length, 0xffffffffffffffff) { revert(0, 0) }
            }
            let start, count := tail(4)
            if gt(mul(count, 32), sub(size, start)) { revert(0, 0) }
            calls.offset := start
            calls.length := count
            deadline := calldataload(68)
            start, count := tail(100)
            if gt(count, sub(size, start)) { revert(0, 0) }
            start, count := tail(132)
            if gt(count, sub(size, start)) { revert(0, 0) }
            if extended {
                if gt(calldataload(164), 0xffff) { revert(0, 0) }
                start, count := tail(228)
                if gt(count, sub(size, start)) { revert(0, 0) }
            }
        }
    }

    function _legacyEventArgs() private pure returns (uint16 businessType, uint256 amount, bytes calldata extraData) {
        assembly ("memory-safe") {
            businessType := calldataload(164)
            amount := calldataload(196)
            extraData.offset := add(36, calldataload(228))
            extraData.length := calldataload(sub(extraData.offset, 32))
        }
    }

    function _revert4(uint256 selector) private pure {
        assembly ("memory-safe") {
            mstore(0, shl(224, selector))
            revert(0, 4)
        }
    }
}
