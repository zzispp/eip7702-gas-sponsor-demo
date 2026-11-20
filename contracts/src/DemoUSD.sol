// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// 本地测试用的极简 ERC20（6 位小数，模拟稳定币）
contract DemoUSD {
    string public constant name = "Demo USD";
    string public constant symbol = "dUSD";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 v) external { balanceOf[to] += v; emit Transfer(address(0), to, v); }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v; balanceOf[to] += v;
        emit Transfer(msg.sender, to, v);
        return true;
    }
}
