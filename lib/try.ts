import { BigNumber, ethers } from 'ethers';

const rd_abi = [
  {
    inputs: [
      { internalType: 'address', name: 'admin', type: 'address' },
      { internalType: 'contract IStakeTable', name: 'l2StakeManager', type: 'address' },
      { internalType: 'contract IRewardPuller', name: 'rewardPuller_', type: 'address' },
      { internalType: 'uint256', name: 'attestationWindowLength_', type: 'uint256' },
      { internalType: 'uint256', name: 'attestationPeriod_', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'constructor',
  },
  { inputs: [], name: 'AccessControlBadConfirmation', type: 'error' },
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'bytes32', name: 'neededRole', type: 'bytes32' },
    ],
    name: 'AccessControlUnauthorizedAccount',
    type: 'error',
  },
  { inputs: [], name: 'AmountZero', type: 'error' },
  { inputs: [], name: 'AttestationPeriodPassed', type: 'error' },
  { inputs: [], name: 'AttestationPeriodTooShort', type: 'error' },
  { inputs: [], name: 'AttestationWindowLengthTooLarge', type: 'error' },
  { inputs: [], name: 'BlockAlreadyAttested', type: 'error' },
  { inputs: [], name: 'ECDSAInvalidSignature', type: 'error' },
  {
    inputs: [{ internalType: 'uint256', name: 'length', type: 'uint256' }],
    name: 'ECDSAInvalidSignatureLength',
    type: 'error',
  },
  { inputs: [{ internalType: 'bytes32', name: 's', type: 'bytes32' }], name: 'ECDSAInvalidSignatureS', type: 'error' },
  { inputs: [], name: 'InvalidRewardPuller', type: 'error' },
  { inputs: [], name: 'NoBlockHashAvailable', type: 'error' },
  { inputs: [], name: 'RewardDistributionFailed', type: 'error' },
  { inputs: [], name: 'WindowAlreadyFinalized', type: 'error' },
  { inputs: [], name: 'WindowNotFound', type: 'error' },
  { inputs: [], name: 'ZeroVotes', type: 'error' },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'uint256', name: 'oldAttestationPeriod', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'newAttestationPeriod', type: 'uint256' },
    ],
    name: 'AttestationPeriodUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'originalWindowEnd', type: 'uint256' },
      { indexed: true, internalType: 'uint256', name: 'newWindowEnd', type: 'uint256' },
    ],
    name: 'AttestationWindowExtended',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'uint256', name: 'oldAttestationWindowLength', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'newAttestationWindowLength', type: 'uint256' },
    ],
    name: 'AttestationWindowLengthUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'currentWindowEnd', type: 'uint256' },
      { indexed: true, internalType: 'uint256', name: 'scheduledNextWindowEnd', type: 'uint256' },
    ],
    name: 'AttestationWindowScheduled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'operator', type: 'address' },
      { indexed: true, internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      { indexed: true, internalType: 'bytes32', name: 'graffiti', type: 'bytes32' },
      { indexed: false, internalType: 'bytes32', name: 'votedHash', type: 'bytes32' },
    ],
    name: 'Attested',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: 'address', name: 'oldRewardPuller', type: 'address' },
      { indexed: false, internalType: 'address', name: 'newRewardPuller', type: 'address' },
    ],
    name: 'RewardPullerUpdated',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'window', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'RewardReceived',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'previousAdminRole', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'newAdminRole', type: 'bytes32' },
    ],
    name: 'RoleAdminChanged',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { indexed: true, internalType: 'address', name: 'account', type: 'address' },
      { indexed: true, internalType: 'address', name: 'sender', type: 'address' },
    ],
    name: 'RoleGranted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { indexed: true, internalType: 'address', name: 'account', type: 'address' },
      { indexed: true, internalType: 'address', name: 'sender', type: 'address' },
    ],
    name: 'RoleRevoked',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      { indexed: true, internalType: 'enum IRewardDistributor.AttestationResult', name: 'result', type: 'uint8' },
      { indexed: false, internalType: 'uint256', name: 'attestationRatio', type: 'uint256' },
      { indexed: false, internalType: 'uint256', name: 'rewardsToDistribute', type: 'uint256' },
    ],
    name: 'WindowFinalized',
    type: 'event',
  },
  {
    inputs: [],
    name: 'DEFAULT_ADMIN_ROLE',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'PARAM_SETTER_ROLE',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      { internalType: 'bytes32', name: 'blockHash', type: 'bytes32' },
      { internalType: 'bytes', name: 'additionalData', type: 'bytes' },
      { internalType: 'bytes', name: 'signature', type: 'bytes' },
      { internalType: 'bytes32', name: 'graffiti', type: 'bytes32' },
    ],
    name: 'attest',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'attestationPeriod',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'targetBlockNumber', type: 'uint256' }],
    name: 'attestationResult',
    outputs: [{ internalType: 'enum IRewardDistributor.AttestationResult', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'attestationWindowLength',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'role', type: 'bytes32' }],
    name: 'getRoleAdmin',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { internalType: 'address', name: 'account', type: 'address' },
    ],
    name: 'grantRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { internalType: 'address', name: 'account', type: 'address' },
    ],
    name: 'hasRole',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'latestActiveWindow',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { internalType: 'address', name: 'callerConfirmation', type: 'address' },
    ],
    name: 'renounceRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'bytes32', name: 'role', type: 'bytes32' },
      { internalType: 'address', name: 'account', type: 'address' },
    ],
    name: 'revokeRole',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'rewardPuller',
    outputs: [{ internalType: 'contract IRewardPuller', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'newAttestationPeriod', type: 'uint256' }],
    name: 'setAttestationPeriod',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'newAttestationWindowLength', type: 'uint256' }],
    name: 'setAttestationWindowLength',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'contract IRewardPuller', name: 'newRewardPuller', type: 'address' }],
    name: 'setRewardPuller',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'targetBlockNumber', type: 'uint256' }],
    name: 'status',
    outputs: [{ internalType: 'enum IRewardDistributor.Status', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes4', name: 'interfaceId', type: 'bytes4' }],
    name: 'supportsInterface',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  { stateMutability: 'payable', type: 'receive' },
];

async function main() {
  const provider = new ethers.providers.StaticJsonRpcProvider('https://sepolia.unichain.org', 1301);
  const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
  const addr = '0xD2BF7681662a9b7Ce0C176fFB28392D5DD4B46Ef';

  const abi = ethers.utils.defaultAbiCoder;

  const rd = new ethers.Contract(addr, rd_abi, wallet);

  //await wallet.sendTransaction({
  //  to: addr,
  //  value: ethers.utils.parseEther('0.00000001'),
  //});

  const bn: BigNumber = BigNumber.from(4);
  const bh = '0x5b797ed507a22d09e1dc6de327513dddd189216f6dbd9a197d2d070338c08535';
  console.log(`wallet: ${wallet.address}`);
  console.log(`bn: ${bn}, bh: ${bh}`);
  const encoded = abi.encode(['uint256', 'bytes32', 'bytes'], [bn, bh, '0x']);
  const keccak = ethers.utils.keccak256(encoded);
  const sig = await wallet.signMessage(ethers.utils.arrayify(keccak));
  console.log(`encoded: ${encoded}`);
  console.log(`keccak: ${keccak}`);
  console.log(`sig: ${sig}`);

  //const tx = await rd.attest(bn, bh, '0x', sig, ethers.utils.formatBytes32String('ha'), { gasLimit: 1000000 });
  //console.log(tx.hash);

  //await tx.wait();

  //const tx = await provider.send('debug_traceTransaction', [
  //  '0xcbaa0f227f9543f8575a4e20904e86f83016760ce3eac484cabedcc227f60453',
  //]);
  //const tx = await provider.getTransactionReceipt('0xcbaa0f227f9543f8575a4e20904e86f83016760ce3eac484cabedcc227f60453');
  //console.log(tx);
}

main();
