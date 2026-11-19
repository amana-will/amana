// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Stand-in for Binance's Agent ID NFT on local and testnet demos. Anyone can mint.
///         On BNB Chain mainnet Amana uses the real Agent ID contract instead.
contract MockAgentID is ERC721 {
    uint256 public nextId = 1;

    constructor() ERC721("Test Agent ID", "tAID") {}

    function mint(address to) external returns (uint256 id) {
        id = nextId++;
        _mint(to, id);
    }
}
