// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract VaultPerp is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---- Oracles & Config ----
    address public oracleUpdater;
    address public agentRole; // The AI agent that can slash
    IERC20 public usdc;

    mapping(bytes32 => uint256) public prices; // Asset symbol (e.g. "ETH") => price in 1e18

    // ---- Perp Engine ----
    struct Position {
        address trader;
        bytes32 asset;
        bool isLong;
        uint256 collateral;
        uint256 leverage;
        uint256 size;
        uint256 entryPrice;
        uint256 timestamp;
        bool isOpen;
    }
    
    mapping(uint256 => Position) public positions;
    uint256 public positionCount;

    // ---- Leader/Bond System ----
    struct Leader {
        uint256 bondAmount;
        uint256 performanceFeeBps;
        uint256 totalFollowerStake;
        uint256 accumulatedFees;
        bool isActive;
    }
    mapping(address => Leader) public leaders;

    // ---- Follower System ----
    struct Follower {
        uint256 stakeAmount;
        uint256 claimableSlash;
    }
    mapping(address => mapping(address => Follower)) public followers; // followers[follower][leader]

    // Events
    event PriceUpdated(bytes32 indexed asset, uint256 price);
    event PositionOpened(uint256 indexed positionId, address indexed trader, bytes32 asset, bool isLong, uint256 size, uint256 entryPrice);
    event PositionClosed(uint256 indexed positionId, address indexed trader, int256 realizedPnL);
    event LeaderRegistered(address indexed leader, uint256 bondAmount, uint256 feeBps);
    event Staked(address indexed follower, address indexed leader, uint256 amount);
    event Slashed(address indexed leader, uint256 amount);

    modifier onlyOracle() {
        require(msg.sender == oracleUpdater, "Not oracle");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agentRole, "Not agent");
        _;
    }

    constructor(address _usdc, address _oracleUpdater, address _agentRole) {
        usdc = IERC20(_usdc);
        oracleUpdater = _oracleUpdater;
        agentRole = _agentRole;
    }

    // --- Oracle ---
    function setPrice(bytes32 asset, uint256 price) external onlyOracle {
        prices[asset] = price;
        emit PriceUpdated(asset, price);
    }

    function getPrice(bytes32 asset) public view returns (uint256) {
        require(prices[asset] > 0, "Price not set");
        return prices[asset];
    }

    // --- Trading ---
    function openPosition(bytes32 asset, bool isLong, uint256 collateral, uint256 leverage) public nonReentrant returns (uint256) {
        require(leverage >= 2 && leverage <= 10, "Invalid leverage");
        require(collateral > 0, "Zero collateral");

        usdc.safeTransferFrom(msg.sender, address(this), collateral);

        uint256 currentPrice = getPrice(asset);
        uint256 size = collateral * leverage;

        positionCount++;
        positions[positionCount] = Position({
            trader: msg.sender,
            asset: asset,
            isLong: isLong,
            collateral: collateral,
            leverage: leverage,
            size: size,
            entryPrice: currentPrice,
            timestamp: block.timestamp,
            isOpen: true
        });

        emit PositionOpened(positionCount, msg.sender, asset, isLong, size, currentPrice);
        return positionCount;
    }

    function getPositionPnL(uint256 positionId) public view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;

        uint256 currentPrice = getPrice(pos.asset);
        int256 priceDiff;
        
        if (pos.isLong) {
            priceDiff = int256(currentPrice) - int256(pos.entryPrice);
        } else {
            priceDiff = int256(pos.entryPrice) - int256(currentPrice);
        }

        // PnL = size * (priceDiff / entryPrice)
        // Adjust for precision
        int256 pnl = (int256(pos.size) * priceDiff) / int256(pos.entryPrice);
        return pnl;
    }

    function closePosition(uint256 positionId) public nonReentrant {
        Position storage pos = positions[positionId];
        require(pos.isOpen, "Not open");
        require(pos.trader == msg.sender, "Not owner"); // For simplicity, only owner closes (unless liquidated)

        int256 pnl = getPositionPnL(positionId);
        pos.isOpen = false;

        uint256 payout = 0;
        if (pnl > 0) {
            payout = pos.collateral + uint256(pnl);
        } else {
            uint256 loss = uint256(-pnl);
            if (loss < pos.collateral) {
                payout = pos.collateral - loss;
            }
        }

        if (payout > 0) {
            usdc.safeTransfer(msg.sender, payout);
        }

        emit PositionClosed(positionId, msg.sender, pnl);
    }

    function isLiquidatable(uint256 positionId) public view returns (bool) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return false;

        int256 pnl = getPositionPnL(positionId);
        if (pnl >= 0) return false;

        uint256 loss = uint256(-pnl);
        // Liquidation if remaining collateral < 10% of size (Maintenance Margin)
        uint256 mm = pos.size / 10;
        if (loss >= pos.collateral || (pos.collateral - loss) <= mm) {
            return true;
        }
        return false;
    }

    function liquidate(uint256 positionId) external nonReentrant {
        require(isLiquidatable(positionId), "Cannot liquidate");
        Position storage pos = positions[positionId];
        
        pos.isOpen = false;
        
        // Vault keeps remaining collateral, liquidator could get a fee
        emit PositionClosed(positionId, pos.trader, -int256(pos.collateral));
    }

    // --- Leader/Bond ---
    function registerLeader(uint256 bondAmount, uint256 feeBps) external nonReentrant {
        require(!leaders[msg.sender].isActive, "Already registered");
        require(feeBps <= 5000, "Fee too high"); // max 50%
        require(bondAmount > 0, "Zero bond");

        usdc.safeTransferFrom(msg.sender, address(this), bondAmount);

        leaders[msg.sender] = Leader({
            bondAmount: bondAmount,
            performanceFeeBps: feeBps,
            totalFollowerStake: 0,
            accumulatedFees: 0,
            isActive: true
        });

        emit LeaderRegistered(msg.sender, bondAmount, feeBps);
    }

    function withdrawBond() external nonReentrant {
        Leader storage leader = leaders[msg.sender];
        require(leader.isActive, "Not active");
        require(leader.totalFollowerStake == 0, "Has active followers");

        uint256 amount = leader.bondAmount;
        leader.bondAmount = 0;
        leader.isActive = false;

        usdc.safeTransfer(msg.sender, amount);
    }

    // --- Follower ---
    function stakeOnLeader(address leaderAddr, uint256 amount) external nonReentrant {
        require(leaders[leaderAddr].isActive, "Leader not active");
        require(amount > 0, "Zero amount");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        followers[msg.sender][leaderAddr].stakeAmount += amount;
        leaders[leaderAddr].totalFollowerStake += amount;

        emit Staked(msg.sender, leaderAddr, amount);
    }

    // --- Copy Trade ---
    // (In a full production version, the contract would map leader positions to follower positions.
    // For this prototype, the backend will call openPosition/closePosition directly for followers 
    // to keep the smart contract logic simpler and save gas on ARC.)
    
    // --- Slash ---
    function slash(address leaderAddr, uint256 slashBps) external onlyAgent nonReentrant {
        Leader storage leader = leaders[leaderAddr];
        require(leader.isActive, "Not active");
        require(slashBps <= 10000, "Invalid bps");

        uint256 slashAmount = (leader.bondAmount * slashBps) / 10000;
        leader.bondAmount -= slashAmount;

        // In a complete version, we would distribute this slashAmount proportionally to followers.
        // For simplicity, we can emit an event and have a backend process update follower claimable balances.
        emit Slashed(leaderAddr, slashAmount);
    }
}
