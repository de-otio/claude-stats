"use strict";var u=Object.defineProperty;var h=Object.getOwnPropertyDescriptor;var w=Object.getOwnPropertyNames;var f=Object.prototype.hasOwnProperty;var C=(t,e)=>{for(var r in e)u(t,r,{get:e[r],enumerable:!0})},E=(t,e,r,i)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of w(e))!f.call(t,n)&&n!==r&&u(t,n,{get:()=>e[n],enumerable:!(i=h(e,n))||i.enumerable});return t};var M=t=>E(u({},"__esModule",{value:!0}),t);var x={};C(x,{handler:()=>k});module.exports=M(x);var a=require("@aws-sdk/client-dynamodb"),m=require("@aws-sdk/client-kms"),c=require("@aws-sdk/client-ses"),p=require("node:crypto"),d=new a.DynamoDBClient({}),I=new m.KMSClient({}),_=new c.SESClient({}),S=process.env.TABLE_NAME,A=process.env.KMS_KEY_ID,T=process.env.SES_FROM_EMAIL,N=process.env.SES_CONFIGURATION_SET,y=process.env.APP_URL,g=Number(process.env.MAGIC_LINK_TTL_MINUTES??"15"),b=Number(process.env.MAX_REQUESTS_PER_HOUR??"3"),k=async t=>{let e=t.request.userAttributes.email?.toLowerCase().trim();if(!e&&t.request.clientMetadata?.email&&(e=t.request.clientMetadata.email.toLowerCase().trim()),!e)throw new Error("Email is required. For new users, pass { email } in clientMetadata");await L(e);let r=(0,p.randomUUID)(),i=await R(r),n=Buffer.from(i).toString("base64"),o=Math.floor(Date.now()/1e3),l=o+g*60;await d.send(new a.PutItemCommand({TableName:S,Item:{email:{S:e},sk:{S:"TOKEN"},tokenHash:{S:n},expiresAt:{N:String(l)},used:{BOOL:!1},createdAt:{N:String(o)}}}));let s=`${y}/auth/verify?email=${encodeURIComponent(e)}&token=${encodeURIComponent(r)}`;return await _.send(new c.SendEmailCommand({Source:T,Destination:{ToAddresses:[e]},ConfigurationSetName:N,Message:{Subject:{Data:"Sign in to Claude Stats"},Body:{Html:{Data:U(s)},Text:{Data:`Sign in to Claude Stats by visiting this link:

${s}

This link expires in ${g} minutes.`}}}})),t.response.publicChallengeParameters={email:e,delivery:"EMAIL"},t.response.privateChallengeParameters={challenge:"MAGIC_LINK"},t};async function L(t){let e=Math.floor(Date.now()/1e3),r=e-3600,n=(await d.send(new a.GetItemCommand({TableName:S,Key:{email:{S:t},sk:{S:"RATE_LIMIT"}}}))).Item,o=0,l=e;if(n){let s=Number(n.requestWindowStart?.N??"0");s>r&&(o=Number(n.requestCount?.N??"0"),l=s)}if(o>=b)throw new Error("Please try again later");await d.send(new a.PutItemCommand({TableName:S,Item:{email:{S:t},sk:{S:"RATE_LIMIT"},requestCount:{N:String(o+1)},requestWindowStart:{N:String(l)},expiresAt:{N:String(e+7200)}}}))}async function R(t){let e=await I.send(new m.GenerateMacCommand({KeyId:A,MacAlgorithm:"HMAC_SHA_256",Message:Buffer.from(t,"utf-8")}));if(!e.Mac)throw new Error("KMS GenerateMac returned no Mac");return e.Mac}function U(t){return`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a2e;">Sign in to Claude Stats</h2>
  <p>Click the button below to sign in. This link expires in ${g} minutes.</p>
  <a href="${t}"
     style="display: inline-block; background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 16px 0;">
    Sign In
  </a>
  <p style="color: #666; font-size: 14px;">If you did not request this link, you can safely ignore this email.</p>
</body>
</html>`.trim()}0&&(module.exports={handler});
//# sourceMappingURL=index.js.map
