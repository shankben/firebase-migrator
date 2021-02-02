import AWS from "aws-sdk";
AWS.config.update({ region: process.env.AWS_REGION });
const sfn = new AWS.StepFunctions();

const execute = async (stateMachineArn: string) => {
  const {
    executionArn,
    startDate
  } = await sfn.startExecution({ stateMachineArn }).promise();
  return {
    PhysicalResourceId: `${executionArn}${startDate}`,
    Data: { executionArn }
  };
};

const pollStatus = async (executionArn: string) => {
  if (!executionArn) return { IsComplete: false };
  const { status } = await sfn.describeExecution({ executionArn }).promise();
  return { IsComplete: status === "SUCCEEDED" };
};

exports.onEvent = async (event: any) => {
  switch (event.RequestType) {
    case "Create":
    case "Update":
      return await execute(event.ResourceProperties.stateMachineArn);
    default: return;
  }
};

exports.isComplete = async (event: any) => {
  switch (event.RequestType) {
    case "Delete":
      return { IsComplete: true };
    case "Create":
    case "Update":
      return await pollStatus(event.Data.executionArn);
    default: return;
  }
};
