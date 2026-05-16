// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "openzeppelin-contracts/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

contract AgentRegistry is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE    = keccak256("ADMIN_ROLE");
    bytes32 public constant SELLER_ROLE   = keccak256("SELLER_ROLE");
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant SLASHER_ROLE  = keccak256("SLASHER_ROLE"); // ✅ NEW

    uint256 public minSellerStake;   // 18 decimals
    uint256 public minVerifierStake; // 18 decimals
    uint64  public withdrawCooldown; // seconds

    struct AgentProfile {
        bool active;
        bytes32 capabilitiesHash;
        bytes32 pubKey;
    }

    mapping(address => AgentProfile) public profile;

    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public lockedStakeOf;

    mapping(address => uint256) public pendingWithdrawAmount;
    mapping(address => uint64)  public pendingWithdrawReadyAt;

    event AgentRegistered(address indexed agent, bytes32 capabilitiesHash, bytes32 pubKey);
    event AgentUpdated(address indexed agent, bytes32 capabilitiesHash, bytes32 pubKey, bool active);

    event StakeToppedUp(address indexed agent, uint256 amount, uint256 newStake);
    event WithdrawRequested(address indexed agent, uint256 amount, uint64 readyAt);
    event WithdrawCanceled(address indexed agent, uint256 amountUnlocked);
    event WithdrawCompleted(address indexed agent, uint256 amount, uint256 newStake);

    event RolesUpdated(address indexed agent, bool seller, bool verifier);
    event MinStakeUpdated(uint256 minSellerStake, uint256 minVerifierStake);
    event WithdrawCooldownUpdated(uint64 withdrawCooldown);

    event StakeSlashed(address indexed agent, uint256 amount, address indexed recipient); // ✅ NEW

    constructor(
        address admin,
        uint256 _minSellerStake,
        uint256 _minVerifierStake,
        uint64 _withdrawCooldown
    ) {
        require(admin != address(0), "BAD_ADMIN");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);

        minSellerStake = _minSellerStake;
        minVerifierStake = _minVerifierStake;
        withdrawCooldown = _withdrawCooldown;

        emit MinStakeUpdated(_minSellerStake, _minVerifierStake);
        emit WithdrawCooldownUpdated(_withdrawCooldown);
    }

    // -------------------------
    // Admin config
    // -------------------------
    function setMinStakes(uint256 _minSellerStake, uint256 _minVerifierStake)
        external
        onlyRole(ADMIN_ROLE)
    {
        minSellerStake = _minSellerStake;
        minVerifierStake = _minVerifierStake;
        emit MinStakeUpdated(_minSellerStake, _minVerifierStake);
    }

    function setWithdrawCooldown(uint64 _cooldown) external onlyRole(ADMIN_ROLE) {
        withdrawCooldown = _cooldown;
        emit WithdrawCooldownUpdated(_cooldown);
    }

    // -------------------------
    // Views
    // -------------------------
    function isActive(address agent) external view returns (bool) {
        return profile[agent].active;
    }

    function isSeller(address agent) external view returns (bool) {
        return profile[agent].active && hasRole(SELLER_ROLE, agent);
    }

    function isVerifier(address agent) external view returns (bool) {
        return profile[agent].active && hasRole(VERIFIER_ROLE, agent);
    }

    function availableStake(address agent) public view returns (uint256) {
        return stakeOf[agent] - lockedStakeOf[agent];
    }

    // -------------------------
    // Registration / profile
    // -------------------------
    function register(
        bool asSeller,
        bool asVerifier,
        bytes32 capabilitiesHash,
        bytes32 pubKey
    ) external payable nonReentrant {
        require(asSeller || asVerifier, "NO_ROLE");

        if (msg.value > 0) {
            stakeOf[msg.sender] += msg.value;
            emit StakeToppedUp(msg.sender, msg.value, stakeOf[msg.sender]);
        }

        AgentProfile storage p = profile[msg.sender];
        bool wasActive = p.active;

        p.active = true;
        p.capabilitiesHash = capabilitiesHash;
        p.pubKey = pubKey;

        if (!wasActive) emit AgentRegistered(msg.sender, capabilitiesHash, pubKey);
        else emit AgentUpdated(msg.sender, capabilitiesHash, pubKey, true);

        if (asSeller) _ensureSeller(msg.sender);
        if (asVerifier) _ensureVerifier(msg.sender);
    }

    function updateProfile(bytes32 capabilitiesHash, bytes32 pubKey, bool active) external {
        AgentProfile storage p = profile[msg.sender];
        require(p.active || active, "NOT_REGISTERED");

        p.capabilitiesHash = capabilitiesHash;
        p.pubKey = pubKey;
        p.active = active;

        emit AgentUpdated(msg.sender, capabilitiesHash, pubKey, active);

        if (!active) {
            if (hasRole(SELLER_ROLE, msg.sender)) _revokeRole(SELLER_ROLE, msg.sender);
            if (hasRole(VERIFIER_ROLE, msg.sender)) _revokeRole(VERIFIER_ROLE, msg.sender);
            emit RolesUpdated(msg.sender, false, false);
        }
    }

    function setRoles(bool wantSeller, bool wantVerifier) external {
        require(profile[msg.sender].active, "NOT_ACTIVE");

        if (wantSeller) _ensureSeller(msg.sender);
        else if (hasRole(SELLER_ROLE, msg.sender)) _revokeRole(SELLER_ROLE, msg.sender);

        if (wantVerifier) _ensureVerifier(msg.sender);
        else if (hasRole(VERIFIER_ROLE, msg.sender)) _revokeRole(VERIFIER_ROLE, msg.sender);

        emit RolesUpdated(
            msg.sender,
            wantSeller && hasRole(SELLER_ROLE, msg.sender),
            wantVerifier && hasRole(VERIFIER_ROLE, msg.sender)
        );
    }

    // -------------------------
    // Top up stake
    // -------------------------
    function topUpStake() external payable nonReentrant {
        require(msg.value > 0, "BAD_AMOUNT");
        stakeOf[msg.sender] += msg.value;
        emit StakeToppedUp(msg.sender, msg.value, stakeOf[msg.sender]);
    }

    // -------------------------
    // Withdraw (2-step, locks immediately)
    // -------------------------
    function requestWithdraw(uint256 amount) external {
        require(amount > 0, "BAD_AMOUNT");
        require(pendingWithdrawAmount[msg.sender] == 0, "PENDING_EXISTS");
        require(availableStake(msg.sender) >= amount, "AVAIL_LOW");

        uint64 readyAt = uint64(block.timestamp) + withdrawCooldown;

        pendingWithdrawAmount[msg.sender] = amount;
        pendingWithdrawReadyAt[msg.sender] = readyAt;

        lockedStakeOf[msg.sender] += amount;

        _enforceRolesAfterStakeChange(msg.sender);

        emit WithdrawRequested(msg.sender, amount, readyAt);
    }

    function cancelWithdraw() external {
        uint256 amount = pendingWithdrawAmount[msg.sender];
        require(amount > 0, "NO_PENDING");

        pendingWithdrawAmount[msg.sender] = 0;
        pendingWithdrawReadyAt[msg.sender] = 0;

        lockedStakeOf[msg.sender] -= amount;

        emit WithdrawCanceled(msg.sender, amount);
    }

    function completeWithdraw() external nonReentrant {
        uint256 amount = pendingWithdrawAmount[msg.sender];
        uint64 readyAt = pendingWithdrawReadyAt[msg.sender];

        require(amount > 0, "NO_PENDING");
        require(block.timestamp >= readyAt, "NOT_READY");

        // Must still be locked (slash could reduce ability)
        require(lockedStakeOf[msg.sender] >= amount, "LOCK_LOW");

        pendingWithdrawAmount[msg.sender] = 0;
        pendingWithdrawReadyAt[msg.sender] = 0;

        lockedStakeOf[msg.sender] -= amount;
        stakeOf[msg.sender] -= amount;

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "NATIVE_SEND_FAIL");

        _enforceRolesAfterStakeChange(msg.sender);

        emit WithdrawCompleted(msg.sender, amount, stakeOf[msg.sender]);
    }

    // -------------------------
    // ✅ SLASHING (called by TaskEscrow)
    // -------------------------
    function slash(address agent, uint256 amount, address recipient)
        external
        nonReentrant
        onlyRole(SLASHER_ROLE)
    {
        require(recipient != address(0), "BAD_RECIPIENT");
        require(amount > 0, "BAD_AMOUNT");
        require(stakeOf[agent] >= amount, "STAKE_LOW");

        // Reduce stake
        uint256 newStake = stakeOf[agent] - amount;
        stakeOf[agent] = newStake;

        // Ensure locked does not exceed new stake
        if (lockedStakeOf[agent] > newStake) {
            lockedStakeOf[agent] = newStake;
        }

        // If pending withdraw is now impossible, reduce it to what's still locked
        uint256 pend = pendingWithdrawAmount[agent];
        if (pend > 0 && pend > lockedStakeOf[agent]) {
            pendingWithdrawAmount[agent] = lockedStakeOf[agent];
            // keep same readyAt; agent can withdraw reduced amount later
        }

        _enforceRolesAfterStakeChange(agent);

        (bool ok,) = payable(recipient).call{value: amount}("");
        require(ok, "SLASH_SEND_FAIL");

        emit StakeSlashed(agent, amount, recipient);
    }

    // -------------------------
    // Internal role ensures
    // -------------------------
    function _ensureSeller(address agent) internal {
        require(profile[agent].active, "NOT_ACTIVE");
        require(availableStake(agent) >= minSellerStake, "SELLER_STAKE_LOW");
        if (!hasRole(SELLER_ROLE, agent)) _grantRole(SELLER_ROLE, agent);
    }

    function _ensureVerifier(address agent) internal {
        require(profile[agent].active, "NOT_ACTIVE");
        require(availableStake(agent) >= minVerifierStake, "VERIFIER_STAKE_LOW");
        if (!hasRole(VERIFIER_ROLE, agent)) _grantRole(VERIFIER_ROLE, agent);
    }

    function _enforceRolesAfterStakeChange(address agent) internal {
        // Revoke if under mins
        if (hasRole(SELLER_ROLE, agent) && availableStake(agent) < minSellerStake) {
            _revokeRole(SELLER_ROLE, agent);
        }
        if (hasRole(VERIFIER_ROLE, agent) && availableStake(agent) < minVerifierStake) {
            _revokeRole(VERIFIER_ROLE, agent);
        }
    }
}
