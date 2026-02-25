const crypto = require("crypto");
const https = require("https");

exports.handler = async function (event) {
  try {
    const { asins } = event.queryStringParameters || {};

    if (!asins) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing ASINs" }),
      };
    }

    const accessKey = process.env.AMAZON_ACCESS_KEY;
    const secretKey = process.env.AMAZON_SECRET_KEY;
    const partnerTag = process.env.AMAZON_PARTNER_TAG;
    const region = "us-east-1";
    const host = "webservices.amazon.com";
    const path = "/paapi5/getitems";

    const payload = JSON.stringify({
      ItemIds: asins.split(","),
      Resources: [
        "Images.Primary.Large",
        "ItemInfo.Title",
        "Offers.Listings.Price"
      ],
      PartnerTag: partnerTag,
      PartnerType: "Associates",
      Marketplace: "www.amazon.com"
    });

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.substring(0, 8);

    const service = "ProductAdvertisingAPI";
    const algorithm = "AWS4-HMAC-SHA256";

    const canonicalHeaders =
  `content-encoding:amz-1.0\n` +
  `content-type:application/json; charset=utf-8\n` +
  `host:${host}\n` +
  `x-amz-date:${amzDate}\n` +
  `x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems\n`;

    const signedHeaders =
  "content-encoding;content-type;host;x-amz-date;x-amz-target";

    const payloadHash = crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");

    const canonicalRequest =
      `POST\n${path}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

    const credentialScope =
      `${dateStamp}/${region}/${service}/aws4_request`;

    const stringToSign =
      `${algorithm}\n${amzDate}\n${credentialScope}\n` +
      crypto.createHash("sha256").update(canonicalRequest).digest("hex");

    const kDate = crypto
      .createHmac("sha256", "AWS4" + secretKey)
      .update(dateStamp)
      .digest();
    const kRegion = crypto
      .createHmac("sha256", kDate)
      .update(region)
      .digest();
    const kService = crypto
      .createHmac("sha256", kRegion)
      .update(service)
      .digest();
    const kSigning = crypto
      .createHmac("sha256", kService)
      .update("aws4_request")
      .digest();

    const signature = crypto
      .createHmac("sha256", kSigning)
      .update(stringToSign)
      .digest("hex");

    const authorizationHeader =
      `${algorithm} Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const options = {
  hostname: host,
  path: path,
  method: "POST",
  headers: {
    "Content-Encoding": "amz-1.0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Amz-Date": amzDate,
    "X-Amz-Target": "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
    Authorization: authorizationHeader,
  },
};

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            statusCode: 200,
            body: data,
          });
        });
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
