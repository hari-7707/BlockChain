"use strict";

const express = require("express");
const app = express();
const morgan = require("morgan");
const Blockchain = require("./blockchain");
const uuid = require("uuid/v1");
const port = process.argv[2];
const rp = require("request-promise");

const nodeAddress = uuid().split("-").join("");

var bitcoin = new Blockchain();

app.use(morgan("tiny"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/static", express.static("public"));

app.get("/address", (req, res) => {
	res.json({
		address: nodeAddress,
	});
});
// get entire blockchain
app.get("/blockchain", function (req, res) {
	res.send(bitcoin);
});

// create a new transaction
app.post("/transaction", function (req, res) {
	const newTransaction = req.body;
	// console.log(req);
	const blockIndex =
		bitcoin.addTransactionToPendingTransactions(newTransaction);
	res.json({
		note: `Transaction will be added in block ${blockIndex}.`,
		state: "success",
	});
});

// broadcast transaction
app.post("/transaction/broadcast", function (req, res) {
	const newTransaction = bitcoin.createNewTransaction(
		req.body.amount,
		req.body.sender,
		req.body.recipient
	);
	bitcoin.addTransactionToPendingTransactions(newTransaction);

	const requestPromises = [];
	console.log(bitcoin.networkNodes);
	try {
		bitcoin.networkNodes.forEach((networkNodeUrl) => {
			const requestOptions = {
				uri: networkNodeUrl + "/transaction",
				method: "POST",
				body: newTransaction,
				json: true,
			};

			requestPromises.push(rp(requestOptions));
		});

		Promise.all(requestPromises).then((data) => {
			res.json({
				note: "Transaction created and broadcast successfully.",
				state: "success",
			});
		});
	} catch (error) {
		console.log(error);
	}
});

// mine a block
app.get("/mine", function (req, res) {
	const lastBlock = bitcoin.getLastBlock();
	const previousBlockHash = lastBlock["hash"];
	if (bitcoin.pendingTransactions.length === 0) {
		res.json({
			note: "Can't mine as there are no pending transaction",
			state: "failure",
		});
	} else {
		const currentBlockData = {
			transactions: bitcoin.pendingTransactions,
			index: lastBlock["index"] + 1,
		};

		const nonce = bitcoin.proofOfWork(previousBlockHash, currentBlockData);
		const blockHash = bitcoin.hashBlock(
			previousBlockHash,
			currentBlockData,
			nonce
		);
		const newBlock = bitcoin.createNewBlock(
			nonce,
			previousBlockHash,
			blockHash
		);

		const requestPromises = [];
		bitcoin.networkNodes.forEach((networkNodeUrl) => {
			const requestOptions = {
				uri: networkNodeUrl + "/receive-new-block",
				method: "POST",
				body: { newBlock: newBlock },
				json: true,
			};

			requestPromises.push(rp(requestOptions));
		});

		Promise.all(requestPromises)
			.then((data) => {
				const requestOptions = {
					uri: bitcoin.currentNodeUrl + "/transaction/broadcast",
					method: "POST",
					body: {
						amount: 100,
						sender: "Host",
						recipient: nodeAddress,
					},
					json: true,
				};

				return rp(requestOptions);
			})
			.then((data) => {
				res.json({
					note: "New block mined successfully",
					block: newBlock,
					state: "success",
				});
			});
	}
});

// receive new block
app.post("/receive-new-block", function (req, res) {
	const newBlock = req.body.newBlock;
	const lastBlock = bitcoin.getLastBlock();
	const correctHash = lastBlock.hash === newBlock.previousBlockHash;
	const correctIndex = lastBlock["index"] + 1 === newBlock["index"];

	if (correctHash && correctIndex) {
		bitcoin.chain.push(newBlock);
		bitcoin.pendingTransactions = [];
		res.json({
			note: "New block received and accepted.",
			newBlock: newBlock,
		});
	} else {
		res.json({
			note: "New block rejected.",
			newBlock: newBlock,
		});
	}
});

// register a node and broadcast it the network
app.post("/register-and-broadcast-node", function (req, res) {
	var newNodeUrl;
	if (req.body.newNodeUrl[req.body.newNodeUrl.length - 1] === "/")
		newNodeUrl = req.body.newNodeUrl.slice(0, -1);
	else newNodeUrl = req.body.newNodeUrl;

	console.log("newNodeUrl", newNodeUrl);
	if (bitcoin.networkNodes.indexOf(newNodeUrl) == -1)
		bitcoin.networkNodes.push(newNodeUrl);

	const regNodesPromises = [];
	bitcoin.networkNodes.forEach((networkNodeUrl) => {
		const requestOptions = {
			uri: networkNodeUrl + "/register-node",
			method: "POST",
			body: { newNodeUrl: newNodeUrl },
			json: true,
		};

		regNodesPromises.push(rp(requestOptions));
	});
	try {
	} catch (error) {}
	Promise.all(regNodesPromises)
		.catch((e) => {
			console.log("error");
		})
		.then((data) => {
			const bulkRegisterOptions = {
				uri: newNodeUrl + "/register-nodes-bulk",
				method: "POST",
				body: {
					allNetworkNodes: [...bitcoin.networkNodes, bitcoin.currentNodeUrl],
				},
				json: true,
			};
			console.log(1);

			return rp(bulkRegisterOptions);
		})
		.then((data) => {
			res.json({
				note: "New node registered with network successfully.",
				state: "success",
			});
		});
});

// register a node with the network
app.post("/register-node", function (req, res) {
	const newNodeUrl = req.body.newNodeUrl;

	const nodeNotAlreadyPresent = bitcoin.networkNodes.indexOf(newNodeUrl) == -1;

	const notCurrentNode = bitcoin.currentNodeUrl !== newNodeUrl;

	if (nodeNotAlreadyPresent && notCurrentNode) {
		bitcoin.networkNodes.push(newNodeUrl);
	}

	res.json({ note: "New node registered successfully.", state: "success" });
});

// register multiple nodes at once
app.post("/register-nodes-bulk", function (req, res) {
	const allNetworkNodes = req.body.allNetworkNodes;
	allNetworkNodes.forEach((networkNodeUrl) => {
		const nodeNotAlreadyPresent =
			bitcoin.networkNodes.indexOf(networkNodeUrl) === -1;
		const notCurrentNode = bitcoin.currentNodeUrl !== networkNodeUrl;
		if (nodeNotAlreadyPresent && notCurrentNode)
			bitcoin.networkNodes.push(networkNodeUrl);
	});

	res.json({ note: "Bulk registration successful.", state: "success" });
});

// consensus
app.get("/consensus", function (req, res) {
	const requestPromises = [];

	const requestOptions = {
		uri: bitcoin.currentNodeUrl + "/blockchain",
		method: "GET",
		json: true,
	};

	requestPromises.push(rp(requestOptions));
	bitcoin.networkNodes.forEach((networkNodeUrl) => {
		const requestOptions = {
			uri: networkNodeUrl + "/blockchain",
			method: "GET",
			json: true,
		};

		requestPromises.push(rp(requestOptions));
	});

	Promise.all(requestPromises).then((blockchains) => {
		const currentChainLength = bitcoin.chain.length;
		var maxChainLength = currentChainLength;
		var minChainLength = currentChainLength;
		var newLongestChain = null;
		var newShortestChain = null;
		var newLongestPendingTransactions = null;
		var newShortestPendingTransactions = null;
		if (blockchains[0]) {
			var newShortestChain = blockchains[0].chain;
			var newPendingTransactions = null;
		}
		blockchains.forEach((blockchain) => {
			if (blockchain.chain.length >= maxChainLength) {
				maxChainLength = blockchain.chain.length;
				newLongestChain = blockchain.chain;
				newLongestPendingTransactions = blockchain.pendingTransactions;
			}
			if (blockchain.chain.length <= newShortestChain.length) {
				newShortestChain = blockchain.chain;
				minChainLength = blockchain.chain.length;
				newShortestPendingTransactions = blockchain.pendingTransactions;
			}
		});

		// console.log(newLongestChain);

		var a = false;
		var b = false;
		var c = false;
		var d = false;
		if (newShortestChain) {
			var a = JSON.stringify(newLongestChain);
			var d = JSON.stringify(newShortestPendingTransactions);
		}
		if (newLongestChain) {
			var b = JSON.stringify(newShortestChain);
			var c = JSON.stringify(newLongestPendingTransactions);
		}
		if (
			!newShortestChain &&
			!newLongestChain &&
			!newLongestPendingTransactions &&
			!newShortestPendingTransactions
		) {
			var a = true;
			var b = true;
			var c = true;
			var d = true;
			console.log("failure goes to ");
		}
		// console.log(
		// 	!newLongestChain,
		// 	newLongestChain,
		// 	bitcoin.chainIsValid(newLongestChain),
		// 	"a= " + a,
		// 	"b= " + b,
		// 	"c= " + c,
		// 	"d= " + d,
		// 	maxChainLength,
		// 	minChainLength
		// );

		if (
			!newLongestChain ||
			(newLongestChain &&
				bitcoin.chainIsValid(newLongestChain) &&
				bitcoin.chainIsValid(newShortestChain) &&
				a === b &&
				c === d &&
				maxChainLength === minChainLength)
		) {
			res.json({
				note: "Current chain has not been replaced.",
				chain: bitcoin.chain,
				state: "success",
			});
		} else {
			bitcoin.chain = newLongestChain;
			bitcoin.pendingTransactions = newPendingTransactions;
			res.json({
				note: "This chain has been replaced.",
				chain: bitcoin.chain,
				state: "failure",
			});
		}
	});
});

// get block by blockHash
app.get("/block/:blockHash", function (req, res) {
	const blockHash = req.params.blockHash;
	const correctBlock = bitcoin.getBlock(blockHash);
	res.json({
		block: correctBlock,
	});
});

// get transaction by transactionId
app.get("/transaction/:transactionId", function (req, res) {
	const transactionId = req.params.transactionId;
	const trasactionData = bitcoin.getTransaction(transactionId);
	res.json({
		transaction: trasactionData.transaction,
		block: trasactionData.block,
	});
});

// get address by address
app.get("/address/:address", function (req, res) {
	const address = req.params.address;
	const addressData = bitcoin.getAddressData(address);
	res.json({
		addressData: addressData,
	});
});

// // block explorer
// app.get("/block-explorer", function (req, res) {
// 	res.sendFile("./block-explorer/index.html", { root: __dirname });
// });

app.get("/", (req, res) => {
	res.sendFile("./block-explorer/home.html", { root: __dirname });
});

app.listen(port, function () {
	console.log(`Listening on port ${port}...`);
});
