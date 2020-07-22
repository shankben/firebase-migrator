const AWS = require("aws-sdk");
AWS.config.update({ region: process.env.AWS_REGION });
const sfn = new AWS.StepFunctions();

const execute = async (stateMachineArn, writeQueueUrl) => {
  const {
    executionArn,
    startDate
  } = await sfn.startExecution({ stateMachineArn }).promise();
  return {
    PhysicalResourceId: `${executionArn}${startDate}`,
    Data: {
      executionArn,
      writeQueueUrl
    }
  }
};

const status = async (executionArn) => {
  if (!executionArn) return { IsComplete: false };
  const { status } = await sfn.describeExecution({ executionArn }).promise();
  return { IsComplete: status === "SUCCEEDED" };
};

exports.onEvent = async (event) => {
  switch (event.RequestType) {
    case "Create":
    case "Update":
      return await execute(event.ResourceProperties.stateMachineArn);
  }
};

exports.isComplete = async (event) => {
  switch (event.RequestType) {
    case "Delete":
      return { IsComplete: true };
    case "Create":
    case "Update":
      return await status(event.Data.executionArn);
  }
};
