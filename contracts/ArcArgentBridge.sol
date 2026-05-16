// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ArcArgentBridge
 * @dev A simple contract to facilitate transfers for restricted agent wallets.
 */
contract ArcArgentBridge {
    event Routed(address indexed from, address indexed to, uint256 amount);

    // This function takes USDC and immediately sends it to the target
    function route(address payable _to) external payable {
        require(msg.value > 0, "Amount must be > 0");
        _to.transfer(msg.value);
        emit Routed(msg.sender, _to, msg.value);
    }
    
    // Allow the contract to receive funds
    receive() external payable {}
}
