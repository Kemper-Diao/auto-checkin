const HOST = 'https://glados.cloud';
const URL_REFERER = `${HOST}/console/checkin`;
const URL_CHECKIN = `${HOST}/api/user/checkin`;
const URL_STATUS = `${HOST}/api/user/status`;

const autoCheckInGLaDOS = async () => {
  const cookie = process.env.GLADOS;
  if (!cookie) {
    console.error('GLADOS secret is missing');
    return;
  }
  try {
    const headers = {
      cookie: cookie,
      referer: URL_REFERER,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'content-type': 'application/json; charset=utf-8'
    };
    const checkin = await fetch(URL_CHECKIN, {
      headers,
      method: 'POST',
      body: '{"token":"glados.cloud"}'
    }).then(r => r.json());
    const status = await fetch(URL_STATUS, {
      headers,
      method: 'GET'
    }).then(r => r.json());
    const result = [
      'Checkin OK',
      `${checkin.message}`,
      `Left Days ${Number(status.data.leftDays)}`
    ];
    console.log(result.join('\n'));
    return result;
  } catch (error) {
    console.error('Checkin Error:', error);
    return [
      'Checkin Error',
      `${error}`,
      `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}>`
    ];
  }
};

autoCheckInGLaDOS();

// PORTALGUN, CYBERCAT, OF-COURSE-I-STILL-LOVE-YOU, HUNTERX
