import AWS from "aws-sdk";
AWS.config.update({ region: process.env.AWS_REGION });
const cognito = new AWS.CognitoIdentityServiceProvider();

exports.handler = async (event: any) => {
  const params = {
    GroupName: process.env.USER_GROUP_NAME!,
    UserPoolId: event.userPoolId,
    Username: event.userName
  };
  await cognito.adminAddUserToGroup(params).promise();
  return event;
};
