const twilio = require('twilio');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { customerPhone, orderDetails } = JSON.parse(event.body);
    const ownerPhone = process.env.SHOP_OWNER_PHONE;

    if (!customerPhone || !orderDetails) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing customerPhone or orderDetails' }) };
    }

    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    // SMS to customer
    await client.messages.create({
      body: `Takk fyri tína bílegging!\n\n${orderDetails}\n\nTú fært víðari upplýsingar innan stuttum.`,
      from: process.env.TWILIO_PHONE,
      to: customerPhone
    });

    // SMS to shop owner
    await client.messages.create({
      body: `Ný bílegging frá: ${customerPhone}\n\n${orderDetails}`,
      from: process.env.TWILIO_PHONE,
      to: ownerPhone
    });

    return { statusCode: 200, body: JSON.stringify({ success: true, message: 'SMS sent successfully' }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
