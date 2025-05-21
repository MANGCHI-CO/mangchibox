const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

exports.handler = async function (event) {
  try {
    // 쿼리 파라미터에서 bundleId 가져오기
    const bundleId = event.queryStringParameters.bundleId;
    if (!bundleId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'bundleId 쿼리 파라미터가 필요합니다.' }),
      };
    }

    // 환경 변수에서 App Store Connect API 자격 증명 가져오기
    const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
    const keyId = process.env.APP_STORE_CONNECT_KEY_ID;
    const privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY;

    if (!issuerId || !keyId || !privateKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'App Store Connect API 자격 증명이 누락되었습니다.' }),
      };
    }

    // JWT 생성
    const token = jwt.sign(
      {
        iss: issuerId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 1200, // 20분 유효
        aud: 'appstoreconnect-v1',
      },
      privateKey,
      { algorithm: 'ES256', header: { kid: keyId, typ: 'JWT' } }
    );

    const apiUrl = 'https://api.appstoreconnect.apple.com/v1';

    // 1. 앱 정보 조회
    const appResponse = await fetch(`${apiUrl}/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!appResponse.ok) {
      const errorData = await appResponse.json().catch(() => ({}));
      return {
        statusCode: appResponse.status,
        body: JSON.stringify({ error: `앱 정보 조회 실패: ${appResponse.statusText} - ${errorData.message || '알 수 없는 오류'}` }),
      };
    }

    const appData = await appResponse.json();
    const apps = appData.data;
    if (!apps || apps.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: '해당 bundleId에 대한 앱을 찾을 수 없습니다.' }),
      };
    }

    const appId = apps[0].id;

    // 2. TestFlight 빌드 조회
    const buildsResponse = await fetch(`${apiUrl}/builds?filter[app]=${appId}&include=preReleaseVersion&limit=10`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!buildsResponse.ok) {
      const errorData = await buildsResponse.json().catch(() => ({}));
      return {
        statusCode: buildsResponse.status,
        body: JSON.stringify({ error: `빌드 조회 실패: ${buildsResponse.statusText} - ${errorData.message || '알 수 없는 오류'}` }),
      };
    }

    const buildsData = await buildsResponse.json();
    const builds = buildsData.data
      .map(build => {
        const version = build.attributes.version || 'Unknown';
        const buildTime = build.attributes.uploadedDate
          ? new Date(build.attributes.uploadedDate).toISOString().replace('T', ' ').slice(0, 19)
          : 'Unknown';
        // Public link는 betaGroups에서 가져와야 함
        let publicLink = '';
        if (build.relationships?.betaGroups?.data?.length > 0) {
          // 단순화를 위해 첫 번째 betaGroup의 public link 가정
          // 실제로는 /betaGroups 엔드포인트 호출 필요
          publicLink = `https://testflight.apple.com/join/${build.relationships.betaGroups.data[0].id}`;
        }
        return {
          version,
          buildTime,
          publicLink,
          bundleId,
        };
      })
      .filter(build => build.publicLink); // 공개 링크가 있는 빌드만 포함

    if (builds.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: '사용 가능한 TestFlight 빌드가 없습니다.' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(builds),
    };
  } catch (error) {
    console.error('Error fetching TestFlight builds:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `TestFlight 빌드 가져오기 실패: ${error.message}` }),
    };
  }
};