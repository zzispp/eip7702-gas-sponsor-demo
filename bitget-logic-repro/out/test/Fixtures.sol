// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Call, IBitget7702Admin} from "../BitgetLogicEquiv.sol";

/// @dev Local fixture only. Digest, permissions, nonce storage, errors and probe
/// modes are not claims about the shipped Admin or its signing protocol.
contract LocalAdminStub is IBitget7702Admin {
    address private constant PLATFORM = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    bytes32 private constant DOMAIN = keccak256("LOCAL ANVIL BITGET LOGIC DIFFERENTIAL FIXTURE");
    mapping(address => mapping(uint256 => bool)) public used; // layout only for the fixture
    bytes32 public lastInputHash;
    address public lastAccount;
    uint8 public returnMode;

    error BadDualSignature();
    error NonceUsed();

    function setReturnMode(uint8 mode) external { returnMode = mode; }

    function verifySignatures(
        Call[] calldata calls, uint256 nonce, uint256 deadline, bytes calldata signerSig, bytes calldata ownerSig
    ) external returns (bool) {
        bytes32 digest = keccak256(abi.encode(DOMAIN, block.chainid, msg.sender, calls, nonce, deadline));
        if (_recover(digest, signerSig) != PLATFORM || _recover(digest, ownerSig) != msg.sender) {
            revert BadDualSignature();
        }
        if (used[msg.sender][nonce]) revert NonceUsed();
        used[msg.sender][nonce] = true;
        lastInputHash = keccak256(msg.data);
        lastAccount = msg.sender;
        uint256 mode = returnMode;
        assembly ("memory-safe") {
            switch mode
            case 1 { mstore(0, 0) return(0, 32) }
            case 2 { return(0, 0) }
            case 3 { mstore(0, 2) return(0, 32) }
            case 4 { mstore(0, 1) mstore(32, 0xCAFE) return(0, 64) }
            case 5 { mstore(0, 1) return(1, 31) }
        }
        return true;
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

contract CallFixture {
    uint256 public count;
    address public lastCaller;
    event Recorded(address indexed caller, uint256 value, bytes data);
    error TargetError(uint256 code);

    function record(bytes calldata data) external payable returns (bool) {
        ++count;
        lastCaller = msg.sender;
        emit Recorded(msg.sender, msg.value, data);
        return false; // a successful EVM CALL may still return false at the ABI level
    }

    function fail(uint256 code) external pure { revert TargetError(code); }
    function failEmpty() external pure { assembly ("memory-safe") { revert(0, 0) } }
}

contract EntryPointFixture {
    bool public rejectPrefund;
    function setRejectPrefund(bool reject) external { rejectPrefund = reject; }
    receive() external payable { require(!rejectPrefund); }

    function invoke(address account, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = account.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
}
