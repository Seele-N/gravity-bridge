import { Peggy } from "./typechain/Peggy";
import { TestERC20 } from "./typechain/TestERC20";
import { ethers } from "ethers";
import fs from "fs";
import commandLineArgs from "command-line-args";
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { exit } from "process";
import { Http2ServerRequest } from "http2";

const args = commandLineArgs([
  // the ethernum node used to deploy the contract
  { name: "eth-node", type: String },
  // the cosmos node that will be used to grab the validator set via RPC (TODO),
  { name: "cosmos-node", type: String },
  // the Ethereum private key that will contain the gas required to pay for the contact deployment
  { name: "eth-privkey", type: String },
  // the peggy contract .json file
  { name: "contract", type: String },
  // the peggy contract erc20 address for the hardcoded erc20 version, only used if test mode is not on
  { name: "erc20-address", type: String },
  // the id to be used for this version of peggy, be sure to avoid conflicts in production
  { name: "peggy-id", type: String },
  // test mode, if enabled this script deploys an erc20 script and uses that script as the contract erc20
  { name: "test-mode", type: String },
  // if test mode is enabled this contract is deployed and it's address is used as the erc20 address in the contract
  { name: "erc20-contract", type: String }
]);

// 4. Now, the deployer script hits a full node api, gets the Eth signatures of the valset from the latest block, and deploys the Ethereum contract.
//     - We will consider the scenario that many deployers deploy many valid peggy eth contracts.
// 5. The deployer submits the address of the peggy contract that it deployed to Ethereum.
//     - The peggy module checks the Ethereum chain for each submitted address, and makes sure that the peggy contract at that address is using the correct source code, and has the correct validator set.
type Validator = {
  power: number;
  ethereum_address: string;
};
type ValsetTypeWrapper = {
  type: string;
  value: Valset;
}
type Valset = {
  members: Validator[];
  nonce: number;
};
type ValsetWrapper = {
  jsonrpc: string;
  id: string;
  result: ValsetResponse;
};
type ValsetResponse = {
  response: ValsetResult
}
type ValsetResult = {
  code: number
  log: string,
  info: string,
  index: string,
  value: string,
  height: string,
  codespace: string,
};
type StatusWrapper = {
  jsonrpc: string,
  id: string,
  result: NodeStatus
};
type NodeInfo = {
  protocol_version: JSON,
  id: string,
  listen_addr: string,
  network: string,
  version: string,
  channels: string,
  moniker: string,
  other: JSON,
};
type SyncInfo = {
  latest_block_hash: string,
  latest_app_hash: string,
  latest_block_height: Number
  latest_block_time: string,
  earliest_block_hash: string,
  earliest_app_hash: string,
  earliest_block_height: Number,
  earliest_block_time: string,
  catching_up: boolean,
}
type NodeStatus = {
  node_info: NodeInfo,
  sync_info: SyncInfo,
  validator_info: JSON,
};

async function deploy() {
  const provider = await new ethers.providers.JsonRpcProvider(args["eth-node"]);
  let wallet = new ethers.Wallet(args["eth-privkey"], provider);
  let contract;

  if (Boolean(args["test-mode"])) {
    console.log("Test mode, deploying ERC20 contract");
    const { abi, bytecode } = getContractArtifacts(args["erc20-contract"]);
    const erc20Factory = new ethers.ContractFactory(abi, bytecode, wallet);

    const testERC20 = (await erc20Factory.deploy()) as TestERC20;

    await testERC20.deployed();
    const erc20TestAddress = testERC20.address;
    contract = erc20TestAddress;
    console.log("ERC20 deployed at Address - ", contract);
  } else {
    contract = args["erc20-address"];
  }
  const peggyId = ethers.utils.formatBytes32String(args["peggy-id"]);

  console.log("Starting Peggy contract deploy");
  const { abi, bytecode } = getContractArtifacts(args["contract"]);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  console.log("About to get latest Peggy valset");
  const latestValset = await getLatestValset(args.peggyId);

  let eth_addresses = [];
  let powers = [];
  // this MUST be sorted uniformly across all components of Peggy in this
  // case we perform the sorting in module/x/peggy/keeper/types.go to the
  // output of the endpoint should always be sorted correctly. If you're
  // having strange problems with updating the validator set you should go
  // look there.
  for (let i = 0; i < latestValset.members.length; i++) {
    eth_addresses.push(latestValset.members[i].ethereum_address);
    powers.push(latestValset.members[i].power);
  }
  const peggy = (await factory.deploy(
    // todo generate this randomly at deployment time that way we can avoid
    // anything but intentional conflicts
    peggyId,
    // 66% of uint32_max
    2834678415,
    eth_addresses,
    powers
  )) as Peggy;

  await peggy.deployed();
  console.log("Peggy deployed at Address - ", peggy.address);
  await submitPeggyAddress(peggy.address);
}

function getContractArtifacts(path: string): { bytecode: string; abi: string } {
  var { bytecode, abi } = JSON.parse(fs.readFileSync(path, "utf8").toString());
  return { bytecode, abi };
}
const decode = (str: string):string => Buffer.from(str, 'base64').toString('binary');
async function getLatestValset(peggyId: string): Promise<Valset> {
  let block_height_request_string = args["cosmos-node"] + '/status';
  let block_height_response = await axios.get(block_height_request_string);
  let info: StatusWrapper = await block_height_response.data;
  let block_height = info.result.sync_info.latest_block_height;
  if (info.result.sync_info.catching_up) {
    console.log("This node is still syncing! You can not deploy using this validator set!");
    exit(1);
  }
  let request_string = args["cosmos-node"] + "/abci_query"
  console.log(request_string)
  let response = await axios.get(request_string, {params: {
    path: "\"/custom/peggy/currentValset/\"",
    height: block_height,
    prove: "false",
  }});
  let valsets: ValsetWrapper = await response.data;
  let valset: ValsetTypeWrapper = JSON.parse(decode(valsets.result.response.value))
  return valset.value;
}

async function submitPeggyAddress(address: string) {}

async function main() {
  await deploy();
}

main();
