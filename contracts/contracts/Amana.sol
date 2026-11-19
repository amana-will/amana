// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Amana
/// @notice A sealed will for your crypto, carried out by the people you trust.
///
/// Your money never leaves your wallet while you're alive. You choose which tokens your will covers and
/// approve Amana to collect up to a limit you set. Only if you stop checking in, your guardians confirm
/// your passing, a 30-day waiting period ends and your guardians unlock your sealed will, does Amana
/// collect what is left (up to your limits) and share it between your heirs.
///
/// Privacy by design:
///   - No names are stored on-chain. Vaults are found with a private join code (only its hash is here).
///   - The will (who inherits, how much, when) is sealed: only its fingerprint (`willHash`) is on-chain,
///     with an encrypted copy whose key is split between the guardians.
///
/// Agent ID is part of the core rules: the owner, every guardian and every heir must hold a Binance
/// Agent ID (the non-transferable .ai name NFT).
///
/// Admin powers: none. No contract owner, pause, upgrade, fee or freeze. Tokens can only move from the
/// owner's wallet after a release, and only to the heirs the sealed will names and the guardians confirm.
///
/// Life cycle (see `status`):
///   Active    – the owner checked in recently (any owner action counts as a check-in).
///   Reminder  – the check-in is due. The agent reminds the owner during `gracePeriod`.
///   Alert     – the grace period is over. Guardians may answer: "they're okay" or "they passed away".
///   Pending   – `threshold` guardians said "passed away". Nothing happens for `cancelWindow`.
///   Released  – the window ended and Amana collected what was left. Guardians unlock the will, heirs are paid.
contract Amana is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Active, Reminder, Alert, Pending, Released }
    enum Vote { None, Okay, Passed }

    struct Plan {
        uint64 checkInInterval; // seconds between check-ins, e.g. 90 days
        uint64 gracePeriod;     // reminder time after a missed check-in before guardians are asked, e.g. 21 days
        uint8 threshold;        // guardians needed for any decision (and to open the will)
        uint64 cancelWindow;    // seconds between "passed away" and release, e.g. 30 days
    }

    struct Vault {
        address owner;
        Plan plan;
        bytes32 willHash;      // fingerprint of the sealed will
        uint64 sealedAtBlock;  // block holding the WillSealed event with the encrypted will
        bool sealCurrent;      // false when guardians changed since the last seal
        uint64 lastCheckIn;
        uint64 releaseAt;      // non-zero while Pending or after Released
        bool released;
        bool opened;           // the will has been opened and checked
        uint256 round;         // votes are counted per round; every reset starts a new one
    }

    struct Heir {
        uint16 shareBps;
        uint64 unlockAt;
        address wallet;        // set when their claim is approved by the guardians
        bool paid;             // every token share has been sent
    }

    uint256 public constant MAX_GUARDIANS = 7;
    uint256 public constant MAX_HEIRS = 12;
    uint256 public constant MAX_TOKENS = 10;

    IERC721 public immutable agentId;

    uint256 public vaultCount;
    mapping(uint256 => Vault) private _vaults;
    mapping(bytes32 => uint256) public vaultByCode;
    mapping(uint256 => address[]) private _tokens;

    mapping(uint256 => address[]) private _guardians;
    mapping(uint256 => mapping(address => bool)) public isGuardian;
    mapping(uint256 => mapping(address => bytes32)) public guardianKey;  // their public encryption key
    mapping(uint256 => mapping(address => bytes32)) public joinRequest;  // pending request: their public key

    mapping(uint256 => Heir[]) private _heirs;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public claimRequested;
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public claimApprovals;
    mapping(uint256 => mapping(uint256 => mapping(address => mapping(address => bool)))) public claimApprovedBy;

    mapping(uint256 => mapping(address => uint256)) public collected;    // amount of each token collected at release
    mapping(uint256 => mapping(address => uint256)) public remaining;    // still to be paid to heirs
    mapping(uint256 => mapping(address => uint256)) public heirsPaidIn; // heirs paid in each token
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public heirPaidToken;

    mapping(uint256 => mapping(uint256 => mapping(address => Vote))) public voteOf;
    mapping(uint256 => mapping(uint256 => mapping(Vote => uint256))) public voteCount;
    mapping(address => uint256[]) private _vaultsOf;

    event VaultCreated(uint256 indexed id, address indexed owner);
    event PlanUpdated(uint256 indexed id);
    event TokensUpdated(uint256 indexed id, address[] tokens);
    event JoinRequested(uint256 indexed id, address indexed wallet, bytes32 publicKey);
    event GuardianApproved(uint256 indexed id, address indexed wallet);
    event GuardianRemoved(uint256 indexed id, address indexed wallet);
    event WillSealed(uint256 indexed id, bytes32 willHash, bytes ciphertext, address[] guardians, bytes[] keyPieces);
    event CheckedIn(uint256 indexed id, address indexed by, uint64 at);
    event Voted(uint256 indexed id, address indexed guardian, Vote vote, uint256 round);
    event VouchedOkay(uint256 indexed id, uint256 round);
    event ReleaseScheduled(uint256 indexed id, uint64 releaseAt);
    event Released(uint256 indexed id);
    event Collected(uint256 indexed id, address indexed token, uint256 amount);
    event WillOpened(uint256 indexed id, uint256 heirs);
    event ClaimRequested(uint256 indexed id, uint256 indexed heir, address indexed wallet);
    event ClaimApproved(uint256 indexed id, uint256 indexed heir, address indexed wallet, address guardian);
    event HeirBound(uint256 indexed id, uint256 indexed heir, address indexed wallet);
    event HeirPaid(uint256 indexed id, uint256 indexed heir, address indexed token, address wallet, uint256 amount);

    error NoAgentId();
    error NotOwner();
    error NotAllowed();
    error NoSuchVault();
    error CodeTaken();
    error AlreadyReleased();
    error WrongStatus(Status current);
    error BadPlan(string reason);
    error NoRequest();
    error WillMismatch();
    error StillLocked(uint64 unlockAt);
    error AlreadyPaid();

    constructor(IERC721 agentId_) {
        agentId = agentId_;
    }

    modifier exists(uint256 id) {
        if (id == 0 || id > vaultCount) revert NoSuchVault();
        _;
    }

    modifier onlyOwner(uint256 id) {
        if (msg.sender != _vaults[id].owner) revert NotOwner();
        _;
    }

    modifier notReleased(uint256 id) {
        if (_vaults[id].released) revert AlreadyReleased();
        _;
    }

    function _requireAgentId(address who) private view {
        if (agentId.balanceOf(who) == 0) revert NoAgentId();
    }

    // ───────────────────────── Owner ─────────────────────────

    function createVault(bytes32 codeHash, Plan calldata plan, address[] calldata coveredTokens) external returns (uint256 id) {
        _requireAgentId(msg.sender);
        if (codeHash == bytes32(0) || vaultByCode[codeHash] != 0) revert CodeTaken();
        id = ++vaultCount;
        vaultByCode[codeHash] = id;
        _vaults[id].owner = msg.sender;
        _setPlan(id, plan);
        _setTokens(id, coveredTokens);
        _vaultsOf[msg.sender].push(id);
        emit VaultCreated(id, msg.sender);
        _reset(id);
    }

    /// @notice "I'm fine." Cancels any reminder, alert or pending release.
    function checkIn(uint256 id) external exists(id) onlyOwner(id) notReleased(id) {
        _reset(id);
    }

    function updatePlan(uint256 id, Plan calldata plan) external exists(id) onlyOwner(id) notReleased(id) {
        _setPlan(id, plan);
        _reset(id);
    }

    /// @notice Chooses which tokens the will covers. The owner also approves Amana for each, up to their own limit.
    function updateTokens(uint256 id, address[] calldata coveredTokens) external exists(id) onlyOwner(id) notReleased(id) {
        _setTokens(id, coveredTokens);
        _reset(id);
    }

    /// @notice Approves people who asked to join as guardians. The app shows matching emojis
    ///         on both phones so the owner can check each request is really from that person.
    function approveGuardians(uint256 id, address[] calldata wallets) external exists(id) onlyOwner(id) notReleased(id) {
        for (uint256 i = 0; i < wallets.length; i++) {
            address w = wallets[i];
            bytes32 key = joinRequest[id][w];
            if (key == bytes32(0)) revert NoRequest();
            if (isGuardian[id][w]) revert NotAllowed();
            delete joinRequest[id][w];
            isGuardian[id][w] = true;
            guardianKey[id][w] = key;
            _guardians[id].push(w);
            _vaultsOf[w].push(id);
            emit GuardianApproved(id, w);
        }
        if (_guardians[id].length > MAX_GUARDIANS) revert BadPlan("at most 7 guardians");
        _vaults[id].sealCurrent = false;
        _reset(id);
    }

    function removeGuardian(uint256 id, address wallet) external exists(id) onlyOwner(id) notReleased(id) {
        if (!isGuardian[id][wallet]) revert NotAllowed();
        address[] storage gs = _guardians[id];
        for (uint256 i = 0; i < gs.length; i++) {
            if (gs[i] == wallet) {
                gs[i] = gs[gs.length - 1];
                gs.pop();
                break;
            }
        }
        isGuardian[id][wallet] = false;
        delete guardianKey[id][wallet];
        _vaults[id].sealCurrent = false;
        emit GuardianRemoved(id, wallet);
        _reset(id);
    }

    /// @notice Seals the will. `willHash` = keccak256(abi.encode(id, shares, unlocks, salt)).
    ///         `ciphertext` is the encrypted will (names, shares, letters); `keyPieces[i]` is a piece of
    ///         its key, encrypted so only guardian i can read it. `threshold` pieces open the will.
    function sealWill(uint256 id, bytes32 willHash, bytes calldata ciphertext, bytes[] calldata keyPieces)
        external
        exists(id)
        onlyOwner(id)
        notReleased(id)
    {
        Vault storage v = _vaults[id];
        address[] memory gs = _guardians[id];
        if (willHash == bytes32(0)) revert BadPlan("empty will");
        if (gs.length < v.plan.threshold) revert BadPlan("not enough guardians yet");
        if (keyPieces.length != gs.length) revert BadPlan("one key piece per guardian");
        v.willHash = willHash;
        v.sealedAtBlock = uint64(block.number);
        v.sealCurrent = true;
        emit WillSealed(id, willHash, ciphertext, gs, keyPieces);
        _reset(id);
    }

    // ───────────────────────── Guardians ─────────────────────────

    /// @notice Asks to join a vault as a guardian. `publicKey` lets the owner seal a piece of the will's key for you.
    function requestJoin(uint256 id, bytes32 publicKey) external exists(id) notReleased(id) {
        _requireAgentId(msg.sender);
        if (msg.sender == _vaults[id].owner || isGuardian[id][msg.sender] || publicKey == bytes32(0)) revert NotAllowed();
        joinRequest[id][msg.sender] = publicKey;
        emit JoinRequested(id, msg.sender, publicKey);
    }

    function vote(uint256 id, Vote choice) external exists(id) notReleased(id) {
        if (!isGuardian[id][msg.sender] || choice == Vote.None) revert NotAllowed();
        Status s = status(id);
        if (s != Status.Alert) revert WrongStatus(s);

        Vault storage v = _vaults[id];
        uint256 r = v.round;
        Vote previous = voteOf[id][r][msg.sender];
        if (previous != Vote.None) voteCount[id][r][previous]--;
        voteOf[id][r][msg.sender] = choice;
        voteCount[id][r][choice]++;
        emit Voted(id, msg.sender, choice, r);

        uint256 t = v.plan.threshold;
        if (voteCount[id][r][Vote.Okay] >= t) {
            emit VouchedOkay(id, r);
            _reset(id);
        } else if (voteCount[id][r][Vote.Passed] >= t) {
            if (v.willHash == bytes32(0)) revert BadPlan("no sealed will");
            v.releaseAt = uint64(block.timestamp) + v.plan.cancelWindow;
            emit ReleaseScheduled(id, v.releaseAt);
        }
    }

    /// @notice Guardians approve an heir's wallet after the will is opened. `threshold` approvals bind it.
    function approveClaim(uint256 id, uint256 heir, address wallet) external exists(id) {
        if (!isGuardian[id][msg.sender]) revert NotAllowed();
        Heir storage h = _heirs[id][heir];
        if (h.wallet != address(0)) revert NotAllowed();
        if (!claimRequested[id][heir][wallet]) revert NoRequest();
        if (claimApprovedBy[id][heir][wallet][msg.sender]) revert NotAllowed();
        claimApprovedBy[id][heir][wallet][msg.sender] = true;
        uint256 n = ++claimApprovals[id][heir][wallet];
        emit ClaimApproved(id, heir, wallet, msg.sender);
        if (n >= _vaults[id].plan.threshold) {
            h.wallet = wallet;
            _vaultsOf[wallet].push(id);
            emit HeirBound(id, heir, wallet);
        }
    }

    // ───────────────────────── Anyone ─────────────────────────

    /// @notice Ends the waiting period and collects what is left of each covered token from the owner's
    ///         wallet, up to the owner's approved limit. Callable by anyone, normally the Amana agent.
    ///         A token that can't be collected (no approval, empty, broken) is skipped, never blocking the rest.
    function finalize(uint256 id) external exists(id) notReleased(id) nonReentrant {
        Vault storage v = _vaults[id];
        if (status(id) != Status.Pending || block.timestamp < v.releaseAt) revert WrongStatus(status(id));
        v.released = true;
        emit Released(id);
        address owner_ = v.owner;
        address[] memory ts = _tokens[id];
        for (uint256 i = 0; i < ts.length; i++) {
            uint256 got = _collect(ts[i], owner_);
            collected[id][ts[i]] = got;
            remaining[id][ts[i]] = got;
            emit Collected(id, ts[i], got);
        }
    }

    /// @notice Opens the will once the guardians' key pieces have unlocked it. The contract only accepts
    ///         the exact will that was sealed: any change breaks the fingerprint.
    function openWill(uint256 id, uint16[] calldata shares, uint64[] calldata unlocks, bytes32 salt) external exists(id) {
        Vault storage v = _vaults[id];
        if (!v.released || v.opened) revert WrongStatus(status(id));
        if (keccak256(abi.encode(id, shares, unlocks, salt)) != v.willHash) revert WillMismatch();
        if (shares.length == 0 || shares.length > MAX_HEIRS || shares.length != unlocks.length) revert WillMismatch();
        uint256 total;
        for (uint256 i = 0; i < shares.length; i++) {
            total += shares[i];
            _heirs[id].push(Heir({shareBps: shares[i], unlockAt: unlocks[i], wallet: address(0), paid: false}));
        }
        if (total != 10_000) revert WillMismatch();
        v.opened = true;
        emit WillOpened(id, shares.length);
    }

    /// @notice An heir asks for their share from their own Agent ID wallet. Guardians then approve it.
    function requestClaim(uint256 id, uint256 heir) external exists(id) {
        _requireAgentId(msg.sender);
        if (!_vaults[id].opened || heir >= _heirs[id].length || _heirs[id][heir].wallet != address(0)) revert NotAllowed();
        claimRequested[id][heir][msg.sender] = true;
        emit ClaimRequested(id, heir, msg.sender);
    }

    /// @notice Sends an heir their share of every collected token. Callable by anyone, normally the Amana agent.
    ///         If one token's transfer fails it stays owed and the call can be repeated.
    function payout(uint256 id, uint256 heir) external exists(id) nonReentrant {
        if (!_vaults[id].opened) revert WrongStatus(status(id));
        Heir storage h = _heirs[id][heir];
        if (h.paid) revert AlreadyPaid();
        if (h.wallet == address(0)) revert NoRequest();
        if (block.timestamp < h.unlockAt) revert StillLocked(h.unlockAt);
        address[] memory ts = _tokens[id];
        uint256 heirCount = _heirs[id].length;
        bool all = true;
        for (uint256 i = 0; i < ts.length; i++) {
            address t = ts[i];
            if (heirPaidToken[id][heir][t]) continue;
            // The last heir paid in a token also receives its rounding dust.
            uint256 amount = heirsPaidIn[id][t] + 1 == heirCount ? remaining[id][t] : (collected[id][t] * h.shareBps) / 10_000;
            if (amount > 0 && !_send(t, h.wallet, amount)) { all = false; continue; }
            heirPaidToken[id][heir][t] = true;
            heirsPaidIn[id][t]++;
            remaining[id][t] -= amount;
            emit HeirPaid(id, heir, t, h.wallet, amount);
        }
        if (all) h.paid = true;
    }

    // ───────────────────────── Views ─────────────────────────

    function status(uint256 id) public view returns (Status) {
        Vault storage v = _vaults[id];
        if (v.released) return Status.Released;
        if (v.releaseAt != 0) return Status.Pending;
        uint256 elapsed = block.timestamp - v.lastCheckIn;
        if (elapsed >= uint256(v.plan.checkInInterval) + v.plan.gracePeriod) return Status.Alert;
        if (elapsed >= v.plan.checkInInterval) return Status.Reminder;
        return Status.Active;
    }

    function getVault(uint256 id) external view exists(id) returns (Vault memory) { return _vaults[id]; }
    function tokens(uint256 id) external view returns (address[] memory) { return _tokens[id]; }
    function guardians(uint256 id) external view returns (address[] memory) { return _guardians[id]; }
    function heirs(uint256 id) external view returns (Heir[] memory) { return _heirs[id]; }
    function vaultsOf(address who) external view returns (uint256[] memory) { return _vaultsOf[who]; }

    /// @notice What Amana could collect today for each token: the smaller of the owner's balance and approved limit.
    function coverage(uint256 id) external view returns (address[] memory ts, uint256[] memory amounts) {
        ts = _tokens[id];
        amounts = new uint256[](ts.length);
        address owner_ = _vaults[id].owner;
        for (uint256 i = 0; i < ts.length; i++) {
            try IERC20(ts[i]).balanceOf(owner_) returns (uint256 bal) {
                try IERC20(ts[i]).allowance(owner_, address(this)) returns (uint256 allowed) {
                    amounts[i] = bal < allowed ? bal : allowed;
                } catch {}
            } catch {}
        }
    }

    // ───────────────────────── Internal ─────────────────────────

    function _collect(address token, address from) private returns (uint256 got) {
        uint256 amount;
        try IERC20(token).balanceOf(from) returns (uint256 bal) {
            try IERC20(token).allowance(from, address(this)) returns (uint256 allowed) {
                amount = bal < allowed ? bal : allowed;
            } catch { return 0; }
        } catch { return 0; }
        if (amount == 0) return 0;
        uint256 before = IERC20(token).balanceOf(address(this));
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) return 0;
        got = IERC20(token).balanceOf(address(this)) - before; // handles tokens that take a fee
    }

    function _send(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    function _reset(uint256 id) private {
        Vault storage v = _vaults[id];
        v.lastCheckIn = uint64(block.timestamp);
        v.releaseAt = 0;
        v.round++;
        emit CheckedIn(id, msg.sender, v.lastCheckIn);
    }

    function _setPlan(uint256 id, Plan calldata plan) private {
        if (plan.checkInInterval < 1 hours) revert BadPlan("check-in interval under 1 hour");
        if (plan.cancelWindow < 1 hours) revert BadPlan("cancel window under 1 hour");
        if (plan.threshold == 0 || plan.threshold > MAX_GUARDIANS) revert BadPlan("1 to 7 guardians must agree");
        _vaults[id].plan = plan;
        emit PlanUpdated(id);
    }

    function _setTokens(uint256 id, address[] calldata ts) private {
        if (ts.length == 0 || ts.length > MAX_TOKENS) revert BadPlan("choose 1 to 10 tokens");
        for (uint256 i = 0; i < ts.length; i++) {
            if (ts[i] == address(0) || ts[i].code.length == 0) revert BadPlan("not a token");
            for (uint256 j = 0; j < i; j++) if (ts[j] == ts[i]) revert BadPlan("duplicate token");
        }
        _tokens[id] = ts;
        emit TokensUpdated(id, ts);
    }
}
