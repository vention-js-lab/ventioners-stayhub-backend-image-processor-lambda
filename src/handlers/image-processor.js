const AWS = require("aws-sdk");
const sharp = require("sharp");
const { encode } = require("blurhash");
const { Client } = require("pg");

console.log("Start...");

const s3 = new AWS.S3();

console.log("Connecting to S3...");

const cdnUrl = process.env.CDN_URL;
const processedImagesBucketName = process.env.S3_PROCESSED_BUCKET_NAME;

console.log("GETTING ENV VARIABLES");

exports.handler = async (event) => {
  console.log("STARTING HANDLER");

  console.log("EVENT:", event);

  const dbClient = new Client({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  });

  console.log("CONNECTING TO DB");

  try {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log("S3 METADATA START:", record);

    const { Metadata } = await s3
      .headObject({
        Bucket: bucket,
        Key: key,
      })
      .promise();

    const accommodationId = Metadata["accommodation-id"];
    const uploadIndex = Metadata["upload-index"];

    console.log(`Processing file: ${key} from bucket: ${bucket}`);

    console.log("Metadata:", Metadata);

    const { Body: imageBuffer } = await s3
      .getObject({ Bucket: bucket, Key: key })
      .promise();

    const sharpInstance = sharp(imageBuffer);

    const [fullSizeBuffer, thumbnailBuffer, { data, info }] = await Promise.all(
      [
        sharpInstance
          .clone()
          .resize({ width: 1280, height: 720 })
          .jpeg({ quality: 80 })
          .toBuffer(),
        sharpInstance
          .clone()
          .resize({
            width: 854,
            height: 480,
          })
          .jpeg({ quality: 80 })
          .toBuffer(),
        sharpInstance
          .clone()
          .resize({ width: 240, height: 427 })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true }),
      ],
    );

    console.log("Image processed and resized");

    const blurhash = encode(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      4,
      4,
    );

    const newKey = key.split("/")[1];

    const fullSizeKey = `fullsize-${newKey}`;
    const thumbnailKey = `thumbnail-${newKey}`;

    console.log("Uploading images to S3...");

    await Promise.all([
      s3
        .putObject({
          Bucket: processedImagesBucketName,
          Key: `processed/${fullSizeKey}`,
          Body: fullSizeBuffer,
          ContentType: "image/jpeg",
        })
        .promise(),
      s3
        .putObject({
          Bucket: processedImagesBucketName,
          Key: `processed/${thumbnailKey}`,
          Body: thumbnailBuffer,
          ContentType: "image/jpeg",
        })
        .promise(),
    ]);

    console.log("Upload complete");

    const fullSizeUrl = `${cdnUrl}/processed/${fullSizeKey}`;
    const thumbnailUrl = `${cdnUrl}/processed/${thumbnailKey}`;

    console.log("Connecting to database...");

    await dbClient.connect();

    console.log("Saving image to database...");

    const query = `
      UPDATE image
      SET
        url = $1,
        "thumbnailUrl" = $2,
        blurhash = $3,
        "order" = $4
      WHERE "accommodationId" = $5 AND "order" = $6
    `;

    const values = [
      fullSizeUrl,
      thumbnailUrl,
      blurhash,
      uploadIndex,
      accommodationId,
      uploadIndex,
    ];

    const result = await dbClient.query(query, values);

    console.log("Database update result:", result);

    if (result.rowCount === 0) {
      console.warn(
        `No image found to update for accommodation ${accommodationId} at index ${uploadIndex}`,
      );
    }

    console.log("Image processing and database save complete.");

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Image processed and saved successfully.",
      }),
    };
  } catch (error) {
    console.error("Error processing image:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Image processing failed." }),
    };
  } finally {
    await dbClient.end();
  }
};
