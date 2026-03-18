"use strict";var c=Object.defineProperty;var h=Object.getOwnPropertyDescriptor;var f=Object.getOwnPropertyNames;var w=Object.prototype.hasOwnProperty;var E=(e,t)=>{for(var r in t)c(e,r,{get:t[r],enumerable:!0})},C=(e,t,r,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of f(t))!w.call(e,n)&&n!==r&&c(e,n,{get:()=>t[n],enumerable:!(o=h(t,n))||o.enumerable});return e};var M=e=>C(c({},"__esModule",{value:!0}),e);var U={};E(U,{handler:()=>k});module.exports=M(U);var a=require("@aws-sdk/client-dynamodb"),m=require("@aws-sdk/client-kms"),u=require("@aws-sdk/client-ses"),p=require("node:crypto"),d=new a.DynamoDBClient({}),A=new m.KMSClient({}),I=new u.SESClient({}),S=process.env.TABLE_NAME,_=process.env.KMS_KEY_ID,T=process.env.SES_FROM_EMAIL,y=process.env.SES_CONFIGURATION_SET,N=process.env.APP_URL,g=Number(process.env.MAGIC_LINK_TTL_MINUTES??"15"),b=Number(process.env.MAX_REQUESTS_PER_HOUR??"3"),k=async e=>{console.log("Event:",JSON.stringify({userAttributes:e.request.userAttributes,clientMetadata:e.request.clientMetadata,userNotFound:e.request.userNotFound},null,2));let t=(e.request.userAttributes?.email||e.request.clientMetadata?.email)?.toLowerCase().trim();if(!t)throw new Error("Email is required. Pass email in userAttributes (existing users) or clientMetadata.email (new users)");await R(t);let r=(0,p.randomUUID)(),o=await L(r),n=Buffer.from(o).toString("base64"),s=Math.floor(Date.now()/1e3),l=s+g*60;await d.send(new a.PutItemCommand({TableName:S,Item:{email:{S:t},sk:{S:"TOKEN"},tokenHash:{S:n},expiresAt:{N:String(l)},used:{BOOL:!1},createdAt:{N:String(s)}}}));let i=`${N}/auth/verify?email=${encodeURIComponent(t)}&token=${encodeURIComponent(r)}`;return await I.send(new u.SendEmailCommand({Source:T,Destination:{ToAddresses:[t]},ConfigurationSetName:y,Message:{Subject:{Data:"Sign in to Claude Stats"},Body:{Html:{Data:x(i)},Text:{Data:`Sign in to Claude Stats by visiting this link:

${i}

This link expires in ${g} minutes.`}}}})),e.response.publicChallengeParameters={email:t,delivery:"EMAIL"},e.response.privateChallengeParameters={challenge:"MAGIC_LINK"},e};async function R(e){let t=Math.floor(Date.now()/1e3),r=t-3600,n=(await d.send(new a.GetItemCommand({TableName:S,Key:{email:{S:e},sk:{S:"RATE_LIMIT"}}}))).Item,s=0,l=t;if(n){let i=Number(n.requestWindowStart?.N??"0");i>r&&(s=Number(n.requestCount?.N??"0"),l=i)}if(s>=b)throw new Error("Please try again later");await d.send(new a.PutItemCommand({TableName:S,Item:{email:{S:e},sk:{S:"RATE_LIMIT"},requestCount:{N:String(s+1)},requestWindowStart:{N:String(l)},expiresAt:{N:String(t+7200)}}}))}async function L(e){let t=await A.send(new m.GenerateMacCommand({KeyId:_,MacAlgorithm:"HMAC_SHA_256",Message:Buffer.from(e,"utf-8")}));if(!t.Mac)throw new Error("KMS GenerateMac returned no Mac");return t.Mac}function x(e){return`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a2e;">Sign in to Claude Stats</h2>
  <p>Click the button below to sign in. This link expires in ${g} minutes.</p>
  <a href="${e}"
     style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0;">
    Sign In
  </a>
  <p style="color: #666; font-size: 14px;">If you did not request this link, you can safely ignore this email.</p>
</body>
</html>`.trim()}0&&(module.exports={handler});
//# sourceMappingURL=index.js.map
