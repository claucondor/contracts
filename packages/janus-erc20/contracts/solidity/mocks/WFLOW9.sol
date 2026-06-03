// SPDX-License-Identifier: MIT
//
// WFLOW9.sol — Wrapped FLOW (WFLOW) — WETH9-compatible.
//
// Canonical testnet WFLOW for use as the JanusWFLOW underlying.
// Mirrors WETH9 exactly: deposit() wraps native FLOW, withdraw() unwraps.
//
// There is no canonical WFLOW on Flow EVM testnet — this is the authoritative
// deployment for the Janus v0.6 sprint.

pragma solidity ^0.8.20;

contract WFLOW9 {
    string public constant name     = "Wrapped FLOW";
    string public constant symbol   = "WFLOW";
    uint8  public constant decimals = 18;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // -----------------------------------------------------------------------
    // Wrap / unwrap
    // -----------------------------------------------------------------------

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "WFLOW9: insufficient balance");
        balanceOf[msg.sender] -= wad;
        (bool ok, ) = payable(msg.sender).call{value: wad}("");
        require(ok, "WFLOW9: FLOW transfer failed");
        emit Withdrawal(msg.sender, wad);
        emit Transfer(msg.sender, address(0), wad);
    }

    // -----------------------------------------------------------------------
    // ERC20
    // -----------------------------------------------------------------------

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 wad) external returns (bool) {
        allowance[msg.sender][spender] = wad;
        emit Approval(msg.sender, spender, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "WFLOW9: insufficient balance");

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "WFLOW9: insufficient allowance");
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);
        return true;
    }
}
