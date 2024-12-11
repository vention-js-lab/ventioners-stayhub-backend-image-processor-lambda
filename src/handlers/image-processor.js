import AWS from "aws-sdk";
import sharp from "sharp";
import { encode } from "blurhash";
import { Client } from "pg";

const s3 = new AWS.S3();
const dbClient = new Client({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});
const cdnUrl = process.env.CDN_URL;

export const handler = async (event) => {
  try {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    const { Metadata } = await s3
      .headObject({
        Bucket: bucket,
        Key: key,
      })
      .promise();

    const accommodationId = Metadata["accommodation-id"];
    const uploadIndex = Metadata["upload-index"];

    console.log(`Processing file: ${key} from bucket: ${bucket}`);

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
          .resize({ width: 240, height: 427 })
          .jpeg({ quality: 95 })
          .toBuffer(),
        sharpInstance
          .clone()
          .resize({ width: 240, height: 427 })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true }),
      ],
    );

    const blurhash = encode(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      4,
      4,
    );

    const fullSizeKey = `${key}-fullsize.jpg`;
    const thumbnailKey = `${key}-thumbnail.jpg`;

    await Promise.all([
      s3
        .putObject({
          Bucket: bucket,
          Key: fullSizeKey,
          Body: fullSizeBuffer,
          ContentType: "image/jpeg",
        })
        .promise(),
      s3
        .putObject({
          Bucket: bucket,
          Key: thumbnailKey,
          Body: thumbnailBuffer,
          ContentType: "image/jpeg",
        })
        .promise(),
    ]);

    const fullSizeUrl = `${cdnUrl}/${fullSizeKey}`;
    const thumbnailUrl = `${cdnUrl}/${thumbnailKey}`;

    await dbClient.connect();

    const query = `
      UPDATE images
      SET
        url = $1,
        thumbnail_url = $2,
        blurhash = $3,
        order = $4
      WHERE accommodation_id = $5 AND order = $6
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
