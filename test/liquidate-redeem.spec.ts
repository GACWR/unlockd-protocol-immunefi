import { parseEther } from "@ethersproject/units";
import BigNumber from "bignumber.js";
import { BigNumber as BN } from "ethers";
import { MAX_UINT_AMOUNT, oneEther } from "../helpers/constants";
import {
  convertToCurrencyDecimals,
  convertToCurrencyUnits,
} from "../helpers/contracts-helpers";
import {
  advanceTimeAndBlock,
  fundWithERC20,
  fundWithERC721,
  increaseTime,
} from "../helpers/misc-utils";
import {
  IConfigNftAsCollateralInput,
  ProtocolErrors,
  ProtocolLoanState,
} from "../helpers/types";
import {
  approveERC20,
  setApprovalForAll,
  setNftAssetPriceForDebt,
} from "./helpers/actions";
import { makeSuite } from "./helpers/make-suite";
import { getUserData } from "./helpers/utils/helpers";

const chai = require("chai");

const { expect } = chai;

makeSuite("LendPool: Redeem", (testEnv) => {
  let baycInitPrice: BN;

  it("WETH - Borrows WETH", async () => {
    const {
      users,
      pool,
      reserveOracle,
      weth,
      bayc,
      configurator,
      deployer,
      nftOracle,
    } = testEnv;
    const depositor = users[0];
    const borrower = users[1];

    //mints USDC to the liquidator
    await fundWithERC20("WETH", depositor.address, "1000");
    await approveERC20(testEnv, depositor, "WETH");

    //deposits WETH
    const amountDeposit = await convertToCurrencyDecimals(
      deployer,
      weth,
      "1000"
    );

    await pool
      .connect(depositor.signer)
      .deposit(weth.address, amountDeposit, depositor.address, "0");

    //mints BAYC to borrower
    await fundWithERC721("BAYC", borrower.address, 101);
    //approve protocol to access borrower wallet
    await setApprovalForAll(testEnv, borrower, "BAYC");

    //borrows
    const price = await convertToCurrencyDecimals(deployer, weth, "1000");

    await configurator.setLtvManagerStatus(deployer.address, true);
    await nftOracle.setPriceManagerStatus(configurator.address, true);

    const collData: IConfigNftAsCollateralInput = {
      asset: bayc.address,
      nftTokenId: "101",
      newPrice: parseEther("100"),
      ltv: 4000,
      liquidationThreshold: 7000,
      redeemThreshold: 5000,
      liquidationBonus: 500,
      redeemDuration: 1,
      auctionDuration: 2,
      redeemFine: 500,
      minBidFine: 2000,
    };
    await configurator
      .connect(deployer.signer)
      .configureNftsAsCollateral([collData]);
    const nftColDataBefore = await pool.getNftCollateralData(
      bayc.address,
      101,
      weth.address
    );

    const wethPrice = await reserveOracle.getAssetPrice(weth.address);

    const amountBorrow = await convertToCurrencyDecimals(
      deployer,
      weth,
      new BigNumber(nftColDataBefore.availableBorrowsInETH.toString())
        .div(wethPrice.toString())
        .multipliedBy(0.95)
        .toFixed(0)
    );

    await pool
      .connect(borrower.signer)
      .borrow(
        weth.address,
        amountBorrow.toString(),
        bayc.address,
        "101",
        borrower.address,
        "0"
      );

    const nftDebtDataAfter = await pool.getNftDebtData(bayc.address, "101");

    expect(nftDebtDataAfter.healthFactor.toString()).to.be.bignumber.gt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("WETH - Drop the health factor below 1", async () => {
    const { weth, bayc, users, pool, configurator, nftOracle, deployer } =
      testEnv;
    const borrower = users[1];

    await nftOracle.setPriceManagerStatus(configurator.address, true);

    const nftDebtDataBefore = await pool.getNftDebtData(bayc.address, "101");

    const debAmountUnits = await convertToCurrencyUnits(
      deployer,
      weth,
      nftDebtDataBefore.totalDebt.toString()
    );
    await setNftAssetPriceForDebt(
      testEnv,
      "BAYC",
      101,
      "WETH",
      debAmountUnits,
      "80"
    );

    const nftDebtDataAfter = await pool.getNftDebtData(bayc.address, "101");

    expect(nftDebtDataAfter.healthFactor.toString()).to.be.bignumber.lt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("WETH - Auctions the borrow", async () => {
    const { weth, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints WETH to the liquidator
    await fundWithERC20("WETH", liquidator.address, "1000");
    await approveERC20(testEnv, liquidator, "WETH");

    const lendPoolBalanceBefore = await weth.balanceOf(pool.address);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(
      bayc.address,
      "101"
    );

    // accurate borrow index, increment interest to loanDataBefore.scaledAmount
    await increaseTime(100);

    const { liquidatePrice } = await pool.getNftLiquidatePrice(
      bayc.address,
      "101"
    );
    const auctionPrice = new BigNumber(liquidatePrice.toString())
      .multipliedBy(1.1)
      .toFixed(0);

    await pool
      .connect(liquidator.signer)
      .auction(bayc.address, "101", auctionPrice, liquidator.address);

    // check result
    const lendPoolBalanceAfter = await weth.balanceOf(pool.address);
    expect(lendPoolBalanceAfter).to.be.equal(
      lendPoolBalanceBefore.add(auctionPrice),
      "Invalid lend pool balance after auction"
    );

    const loanDataAfter = await dataProvider.getLoanDataByLoanId(
      loanDataBefore.loanId
    );
    expect(loanDataAfter.state).to.be.equal(
      ProtocolLoanState.Auction,
      "Invalid loan state after auction"
    );

    const tokenOwner = await bayc.ownerOf("101");
    expect(tokenOwner).to.be.equal(
      uBAYC.address,
      "Invalid token owner after redeem"
    );
  });

  it("WETH - Redeems the borrow", async () => {
    const { weth, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints WETH to the liquidator
    await fundWithERC20("WETH", borrower.address, "1000");
    await approveERC20(testEnv, borrower, "WETH");

    const nftCfgData = await dataProvider.getNftConfigurationDataByTokenId(
      bayc.address,
      "101"
    );

    const auctionDataBefore = await pool.getNftAuctionData(bayc.address, "101");

    const liquidatorBalanceBefore = await weth.balanceOf(liquidator.address);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(
      bayc.address,
      "101"
    );

    const ethReserveDataBefore = await dataProvider.getReserveData(
      weth.address
    );

    const userReserveDataBefore = await getUserData(
      pool,
      dataProvider,
      weth.address,
      borrower.address
    );

    // redeem duration
    await increaseTime(nftCfgData.redeemDuration.mul(24).sub(1).toNumber());

    const debtDataBeforeRedeem = await pool.getNftDebtData(bayc.address, "101");
    const repayDebtAmount = new BigNumber(
      debtDataBeforeRedeem.totalDebt.toString()
    )
      .multipliedBy(0.6)
      .toFixed(0);
    const bidFineAmount = new BigNumber(auctionDataBefore.bidFine.toString())
      .multipliedBy(1.1)
      .toFixed(0);

    await pool
      .connect(borrower.signer)
      .redeem(bayc.address, "101", repayDebtAmount, bidFineAmount);

    // check result
    const tokenOwner = await bayc.ownerOf("101");
    expect(tokenOwner).to.be.equal(
      uBAYC.address,
      "Invalid token owner after redeem"
    );

    const liquidatorBalanceAfter = await weth.balanceOf(liquidator.address);
    expect(liquidatorBalanceAfter).to.be.gte(
      liquidatorBalanceBefore.add(auctionDataBefore.bidFine),
      "Invalid liquidator balance after redeem"
    );

    const loanDataAfter = await dataProvider.getLoanDataByLoanId(
      loanDataBefore.loanId
    );
    expect(loanDataAfter.state).to.be.equal(
      ProtocolLoanState.Active,
      "Invalid loan state after redeem"
    );

    const userReserveDataAfter = await getUserData(
      pool,
      dataProvider,
      weth.address,
      borrower.address
    );

    const ethReserveDataAfter = await dataProvider.getReserveData(weth.address);

    const userVariableDebtAmountBeforeTx = new BigNumber(
      userReserveDataBefore.scaledVariableDebt
    ).rayMul(new BigNumber(ethReserveDataAfter.variableBorrowIndex.toString()));

    expect(
      userReserveDataAfter.currentVariableDebt.toString()
    ).to.be.bignumber.almostEqual(
      userVariableDebtAmountBeforeTx.minus(repayDebtAmount).toString(),
      "Invalid user debt after redeem"
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(ethReserveDataAfter.liquidityIndex.toString()).to.be.bignumber.gte(
      ethReserveDataBefore.liquidityIndex.toString(),
      "Invalid liquidity index"
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(ethReserveDataAfter.liquidityRate.toString()).to.be.bignumber.lt(
      ethReserveDataBefore.liquidityRate.toString(),
      "Invalid liquidity APY"
    );

    expect(
      ethReserveDataAfter.availableLiquidity.toString()
    ).to.be.bignumber.almostEqual(
      new BigNumber(ethReserveDataBefore.availableLiquidity.toString())
        .plus(repayDebtAmount)
        .toFixed(0),
      "Invalid principal available liquidity"
    );
  });

  it("WETH - Repays the borrow", async () => {
    const { weth, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    await advanceTimeAndBlock(100);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(
      bayc.address,
      "101"
    );

    await pool
      .connect(borrower.signer)
      .repay(bayc.address, "101", MAX_UINT_AMOUNT);

    const loanDataAfter = await dataProvider.getLoanDataByLoanId(
      loanDataBefore.loanId
    );
    expect(loanDataAfter.state).to.be.equal(
      ProtocolLoanState.Repaid,
      "Invalid loan state after repay"
    );
  });

  it("USDC - Borrows USDC", async () => {
    const {
      users,
      pool,
      reserveOracle,
      usdc,
      bayc,
      configurator,
      dataProvider,
      nftOracle,
      deployer,
    } = testEnv;
    const depositor = users[0];
    const borrower = users[1];

    //mints USDC to the depositor
    await fundWithERC20("USDC", depositor.address, "100000");
    await approveERC20(testEnv, depositor, "USDC");

    //deposits USDC
    const amountDeposit = await convertToCurrencyDecimals(
      deployer,
      usdc,
      "100000"
    );

    await pool
      .connect(depositor.signer)
      .deposit(usdc.address, amountDeposit, depositor.address, "0");

    //mints BAYC to borrower
    await fundWithERC721("BAYC", borrower.address, 102);
    //approve protocol to access borrower wallet
    await setApprovalForAll(testEnv, borrower, "BAYC");

    await configurator.setLtvManagerStatus(deployer.address, true);
    await nftOracle.setPriceManagerStatus(configurator.address, true);

    const collData: IConfigNftAsCollateralInput = {
      asset: bayc.address,
      nftTokenId: "102",
      newPrice: parseEther("100"),
      ltv: 4000,
      liquidationThreshold: 7000,
      redeemThreshold: 5000,
      liquidationBonus: 500,
      redeemDuration: 1,
      auctionDuration: 2,
      redeemFine: 500,
      minBidFine: 2000,
    };
    await configurator
      .connect(deployer.signer)
      .configureNftsAsCollateral([collData]);
    //borrows
    const nftColDataBefore = await pool.getNftCollateralData(
      bayc.address,
      102,
      usdc.address
    );

    const usdcPrice = await reserveOracle.getAssetPrice(usdc.address);

    const amountBorrow = await convertToCurrencyDecimals(
      deployer,
      usdc,
      new BigNumber(nftColDataBefore.availableBorrowsInETH.toString())
        .div(usdcPrice.toString())
        .multipliedBy(0.95)
        .toFixed(0)
    );

    await pool
      .connect(borrower.signer)
      .borrow(
        usdc.address,
        amountBorrow.toString(),
        bayc.address,
        "102",
        borrower.address,
        "0"
      );

    const nftDebtDataAfter = await pool.getNftDebtData(bayc.address, "102");

    expect(nftDebtDataAfter.healthFactor.toString()).to.be.bignumber.gt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("USDC - Drop the health factor below 1", async () => {
    const { usdc, bayc, users, pool, configurator, nftOracle, deployer } =
      testEnv;
    const borrower = users[1];

    await nftOracle.setPriceManagerStatus(configurator.address, true);

    const nftDebtDataBefore = await pool.getNftDebtData(bayc.address, "102");

    const debAmountUnits = await convertToCurrencyUnits(
      deployer,
      usdc,
      nftDebtDataBefore.totalDebt.toString()
    );
    await setNftAssetPriceForDebt(
      testEnv,
      "BAYC",
      102,
      "USDC",
      debAmountUnits,
      "80"
    );

    const nftDebtDataAfter = await pool.getNftDebtData(bayc.address, "102");

    expect(nftDebtDataAfter.healthFactor.toString()).to.be.bignumber.lt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("USDC - Auctions the borrow", async () => {
    const { usdc, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    await advanceTimeAndBlock(100);

    //mints USDC to the liquidator
    await fundWithERC20("USDC", liquidator.address, "1000000");
    await approveERC20(testEnv, liquidator, "USDC");

    const lendPoolBalanceBefore = await usdc.balanceOf(pool.address);
    console.log("lendPoolBalanceBefore: ", lendPoolBalanceBefore.toString());
    // accurate borrow index, increment interest to loanDataBefore.scaledAmount
    await increaseTime(100);

    const { liquidatePrice } = await pool.getNftLiquidatePrice(
      bayc.address,
      "102"
    );
    const auctionPrice = new BigNumber(liquidatePrice.toString())
      .multipliedBy(1.1)
      .toFixed(0);
    console.log("auction price: ", auctionPrice.toString());
    await pool
      .connect(liquidator.signer)
      .auction(bayc.address, "102", auctionPrice, liquidator.address);

    // check result
    const lendpoolBalanceAfter = await usdc.balanceOf(pool.address);
    expect(lendpoolBalanceAfter).to.be.equal(
      lendPoolBalanceBefore.add(auctionPrice),
      "Invalid lend pool balance after auction"
    );

    const tokenOwner = await bayc.ownerOf("102");
    expect(tokenOwner).to.be.equal(
      uBAYC.address,
      "Invalid token owner after redeem"
    );
  });

  it("USDC - Redeems the borrow", async () => {
    const { usdc, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    await advanceTimeAndBlock(100);

    //mints USDC to the borrower
    await fundWithERC20("USDC", borrower.address, "1000000");
    await approveERC20(testEnv, borrower, "USDC");

    const nftCfgData = await dataProvider.getNftConfigurationDataByTokenId(
      bayc.address,
      "102"
    );

    const auctionDataBefore = await pool.getNftAuctionData(bayc.address, "102");

    const liquidatorBalanceBefore = await usdc.balanceOf(liquidator.address);

    const usdcReserveDataBefore = await dataProvider.getReserveData(
      usdc.address
    );

    const userReserveDataBefore = await getUserData(
      pool,
      dataProvider,
      usdc.address,
      borrower.address
    );

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(
      bayc.address,
      "102"
    );

    // redeem duration
    await increaseTime(nftCfgData.redeemDuration.mul(24).sub(1).toNumber());

    const debtDataBeforeRedeem = await pool.getNftDebtData(bayc.address, "102");
    const repayDebtAmount = new BigNumber(
      debtDataBeforeRedeem.totalDebt.toString()
    )
      .multipliedBy(0.6)
      .toFixed(0);
    const bidFineAmount = new BigNumber(auctionDataBefore.bidFine.toString())
      .multipliedBy(1.1)
      .toFixed(0);

    await pool
      .connect(borrower.signer)
      .redeem(bayc.address, "102", repayDebtAmount, bidFineAmount);

    // check result
    const tokenOwner = await bayc.ownerOf("102");
    expect(tokenOwner).to.be.equal(
      uBAYC.address,
      "Invalid token owner after redeem"
    );

    const liquidatorBalanceAfter = await usdc.balanceOf(liquidator.address);
    expect(liquidatorBalanceAfter).to.be.gte(
      liquidatorBalanceBefore.add(auctionDataBefore.bidFine),
      "Invalid liquidator balance after redeem"
    );

    const loanDataAfter = await dataProvider.getLoanDataByLoanId(
      loanDataBefore.loanId
    );
    expect(loanDataAfter.state).to.be.equal(
      ProtocolLoanState.Active,
      "Invalid loan state after redeem"
    );

    const userReserveDataAfter = await getUserData(
      pool,
      dataProvider,
      usdc.address,
      borrower.address
    );

    const usdcReserveDataAfter = await dataProvider.getReserveData(
      usdc.address
    );

    const userVariableDebtAmountBeforeTx = new BigNumber(
      userReserveDataBefore.scaledVariableDebt
    ).rayMul(
      new BigNumber(usdcReserveDataAfter.variableBorrowIndex.toString())
    );

    expect(
      userReserveDataAfter.currentVariableDebt.toString()
    ).to.be.bignumber.almostEqual(
      userVariableDebtAmountBeforeTx.minus(repayDebtAmount).toString(),
      "Invalid user debt after redeem"
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(usdcReserveDataAfter.liquidityIndex.toString()).to.be.bignumber.gte(
      usdcReserveDataBefore.liquidityIndex.toString(),
      "Invalid liquidity index"
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(usdcReserveDataAfter.liquidityRate.toString()).to.be.bignumber.lt(
      usdcReserveDataBefore.liquidityRate.toString(),
      "Invalid liquidity APY"
    );

    expect(
      usdcReserveDataAfter.availableLiquidity.toString()
    ).to.be.bignumber.almostEqual(
      new BigNumber(usdcReserveDataBefore.availableLiquidity.toString())
        .plus(repayDebtAmount)
        .toFixed(0),
      "Invalid principal available liquidity"
    );
  });

  it("USDC - Repays the borrow", async () => {
    const { usdc, bayc, uBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    await advanceTimeAndBlock(100);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(
      bayc.address,
      "102"
    );

    await pool
      .connect(borrower.signer)
      .repay(bayc.address, "102", MAX_UINT_AMOUNT);

    const loanDataAfter = await dataProvider.getLoanDataByLoanId(
      loanDataBefore.loanId
    );
    expect(loanDataAfter.state).to.be.equal(
      ProtocolLoanState.Repaid,
      "Invalid loan state after repay"
    );
  });
});