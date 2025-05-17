const axios = require('axios');

// 환경 변수에서 설정 가져오기
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
// JSON 문자열로 저장된 저장소 목록을 파싱
const REPOS_TO_MONITOR = JSON.parse(process.env.REPOS_TO_MONITOR || '[]');

// 마지막 확인 시간 (State 유지가 안 되므로 항상 최근 2시간만 확인)
const lastCheckedTime = new Date();
lastCheckedTime.setHours(lastCheckedTime.getHours() - 2);

console.log('GitHub 알림 체커 시작됨');
console.log('모니터링 중인 저장소:', REPOS_TO_MONITOR);
console.log('사용자:', GITHUB_USERNAME);
console.log('마지막 확인 시간:', lastCheckedTime.toISOString());

// GitHub API 호출 설정
const githubAPI = axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json'
  }
});

// GitHub API에 사용할 추가 헤더 (Discussions API용)
const discussionsHeader = {
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json,application/vnd.github.squirrel-girl-preview'
  }
};

// 새 PR 리뷰 요청 확인
async function checkForReviewRequests() {
  console.log('PR 리뷰 요청 확인 중...');
  
  for (const repoFullName of REPOS_TO_MONITOR) {
    const [owner, repo] = repoFullName.split('/');
    
    try {
      console.log(`저장소 확인 중: ${owner}/${repo}`);
      
      // 열린 PR 목록 가져오기
      const response = await githubAPI.get(`/repos/${owner}/${repo}/pulls`, {
        params: { state: 'open' }
      });
      
      console.log(`${response.data.length}개의 열린 PR 발견`);
      
      // 각 PR에 대해 리뷰 요청 확인
      for (const pr of response.data) {
        // PR 세부 정보 가져오기 (리뷰 요청 포함)
        const prDetail = await githubAPI.get(`/repos/${owner}/${repo}/pulls/${pr.number}`);
        
        // 나에게 리뷰 요청이 있는지 확인
        const requestedReviewers = prDetail.data.requested_reviewers || [];
        const isRequestedForMe = requestedReviewers.some(
          reviewer => reviewer.login.toLowerCase() === GITHUB_USERNAME.toLowerCase()
        );
        
        // PR 업데이트 시간이 마지막 확인 이후인지 확인
        const prUpdatedAt = new Date(pr.updated_at);
        
        if (isRequestedForMe && prUpdatedAt > lastCheckedTime) {
          console.log(`새 리뷰 요청 발견: ${pr.title}`);
          
          // Discord로 알림 보내기
          await sendDiscordNotification({
            title: `🔍 새 PR 리뷰 요청이 왔습니다`,
            description: `PR: ${pr.title}`,
            url: pr.html_url,
            author: pr.user.login,
            repo: `${owner}/${repo}`
          });
        }
      }
    } catch (error) {
      console.error(`Error checking ${owner}/${repo} PRs:`, error.message);
    }
  }
}

// 내 PR에 리뷰가 달렸는지 확인
async function checkForNewReviews() {
  console.log('PR 리뷰 확인 중...');
  
  for (const repoFullName of REPOS_TO_MONITOR) {
    const [owner, repo] = repoFullName.split('/');
    
    try {
      // 내가 작성한 열린 PR 가져오기
      const response = await githubAPI.get(`/repos/${owner}/${repo}/pulls`, {
        params: { state: 'open', creator: GITHUB_USERNAME }
      });
      
      console.log(`${response.data.length}개의 내가 작성한 PR 발견`);
      
      // 각 PR에 대해 새 리뷰 확인
      for (const pr of response.data) {
        // PR의 리뷰 목록 가져오기
        const reviews = await githubAPI.get(`/repos/${owner}/${repo}/pulls/${pr.number}/reviews`);
        
        // 마지막 확인 이후 새 리뷰가 있는지 확인
        const newReviews = reviews.data.filter(
          review => new Date(review.submitted_at) > lastCheckedTime
        );
        
        console.log(`PR #${pr.number}에 ${newReviews.length}개의 새 리뷰 발견`);
        
        // 새 리뷰가 있으면 알림 보내기
        for (const review of newReviews) {
          await sendDiscordNotification({
            title: `⚠️ PR에 새 리뷰가 등록되었습니다`,
            description: `PR: ${pr.title} - ${getReviewStateEmoji(review.state)} ${review.state}`,
            url: review.html_url,
            author: review.user.login,
            repo: `${owner}/${repo}`
          });
        }
      }
    } catch (error) {
      console.error(`Error checking reviews for ${owner}/${repo}:`, error.message);
    }
  }
}

// 새 이슈/이슈 댓글 확인
async function checkForNewIssuesAndComments() {
  console.log('이슈 및 이슈 댓글 확인 중...');
  
  for (const repoFullName of REPOS_TO_MONITOR) {
    const [owner, repo] = repoFullName.split('/');
    
    try {
      // 1. 나에게 할당된 이슈 확인
      const assignedIssues = await githubAPI.get(`/repos/${owner}/${repo}/issues`, {
        params: { 
          state: 'open', 
          assignee: GITHUB_USERNAME,
          since: lastCheckedTime.toISOString()
        }
      });
      
      console.log(`${assignedIssues.data.length}개의 새로 할당된 이슈 발견`);
      
      // 새로 할당된 이슈 알림
      for (const issue of assignedIssues.data) {
        // PR이 아닌 이슈만 처리 (PR도 이슈로 반환됨)
        if (!issue.pull_request) {
          await sendDiscordNotification({
            title: `📌 새 이슈가 할당되었습니다`,
            description: `이슈: ${issue.title}`,
            url: issue.html_url,
            author: issue.user.login,
            repo: `${owner}/${repo}`
          });
        }
      }
      
      // 2. 내가 생성한 이슈에 달린 새 댓글 확인
      const myIssues = await githubAPI.get(`/repos/${owner}/${repo}/issues`, {
        params: { 
          state: 'all', 
          creator: GITHUB_USERNAME 
        }
      });
      
      console.log(`${myIssues.data.length}개의 내가 생성한 이슈 발견`);
      
      // 이슈별로 새 댓글 확인
      for (const issue of myIssues.data) {
        // PR이 아닌 이슈만 처리
        if (!issue.pull_request) {
          const comments = await githubAPI.get(issue.comments_url);
          
          // 마지막 확인 이후 새 댓글이 있는지 확인
          const newComments = comments.data.filter(
            comment => 
              new Date(comment.created_at) > lastCheckedTime && 
              comment.user.login.toLowerCase() !== GITHUB_USERNAME.toLowerCase()
          );
          
          for (const comment of newComments) {
            await sendDiscordNotification({
              title: `💬 이슈에 새 댓글이 등록되었습니다`,
              description: `이슈: ${issue.title}\n${truncateText(comment.body, 100)}`,
              url: comment.html_url,
              author: comment.user.login,
              repo: `${owner}/${repo}`
            });
          }
        }
      }
      
      // 3. 내가 언급된(@username) 이슈/댓글 확인
      const mentionedIssues = await githubAPI.get(`/repos/${owner}/${repo}/issues`, {
        params: { 
          state: 'all', 
          mentioned: GITHUB_USERNAME,
          since: lastCheckedTime.toISOString()
        }
      });
      
      console.log(`${mentionedIssues.data.length}개의 내가 언급된 이슈 발견`);
      
      for (const issue of mentionedIssues.data) {
        if (!issue.pull_request) {
          await sendDiscordNotification({
            title: `🔔 이슈에서 언급되었습니다`,
            description: `이슈: ${issue.title}`,
            url: issue.html_url,
            author: issue.user.login,
            repo: `${owner}/${repo}`
          });
        }
      }
      
    } catch (error) {
      console.error(`Error checking issues for ${owner}/${repo}:`, error.message);
    }
  }
}

// Discussions 확인 (GitHub GraphQL API 사용)
async function checkForNewDiscussions() {
  console.log('디스커션 확인 중...');
  
  for (const repoFullName of REPOS_TO_MONITOR) {
    const [owner, repo] = repoFullName.split('/');
    
    try {
      // 1. 최근 디스커션 목록 가져오기 (GraphQL API 사용)
      const discussionsQuery = {
        query: `
          query {
            repository(owner: "${owner}", name: "${repo}") {
              discussions(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
                nodes {
                  id
                  title
                  url
                  author {
                    login
                  }
                  createdAt
                  comments(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
                    nodes {
                      id
                      author {
                        login
                      }
                      createdAt
                      url
                      bodyText
                    }
                  }
                }
              }
            }
          }
        `
      };
      
      const discussionsResponse = await axios.post(
        'https://api.github.com/graphql',
        discussionsQuery,
        {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const discussions = discussionsResponse.data.data.repository?.discussions?.nodes || [];
      
      console.log(`${discussions.length}개의 디스커션 발견`);
      
      // 2. 새 디스커션 확인
      for (const discussion of discussions) {
        const createdAt = new Date(discussion.createdAt);
        
        // 최근 생성된 디스커션 알림
        if (createdAt > lastCheckedTime) {
          // 본인이 작성한 것은 제외
          if (discussion.author.login.toLowerCase() !== GITHUB_USERNAME.toLowerCase()) {
            await sendDiscordNotification({
              title: `📣 새 디스커션이 생성되었습니다`,
              description: `디스커션: ${discussion.title}`,
              url: discussion.url,
              author: discussion.author.login,
              repo: `${owner}/${repo}`
            });
          }
        }
        
        // 3. 디스커션 댓글 확인
        const comments = discussion.comments.nodes || [];
        
        for (const comment of comments) {
          const commentCreatedAt = new Date(comment.createdAt);
          
          if (commentCreatedAt > lastCheckedTime && 
              comment.author.login.toLowerCase() !== GITHUB_USERNAME.toLowerCase()) {
                
            // 자신이 작성한 디스커션에 달린 댓글 알림
            if (discussion.author.login.toLowerCase() === GITHUB_USERNAME.toLowerCase()) {
              await sendDiscordNotification({
                title: `💬 내 디스커션에 새 댓글이 등록되었습니다`,
                description: `디스커션: ${discussion.title}\n${truncateText(comment.bodyText, 100)}`,
                url: comment.url,
                author: comment.author.login,
                repo: `${owner}/${repo}`
              });
            }
            
            // 자신의 댓글이 달린 디스커션의 새 댓글 알림
            else {
              const userCommented = comments.some(c => 
                c.author.login.toLowerCase() === GITHUB_USERNAME.toLowerCase() && 
                new Date(c.createdAt) < commentCreatedAt
              );
              
              if (userCommented) {
                await sendDiscordNotification({
                  title: `💬 내가 참여한 디스커션에 새 댓글이 등록되었습니다`,
                  description: `디스커션: ${discussion.title}\n${truncateText(comment.bodyText, 100)}`,
                  url: comment.url,
                  author: comment.author.login,
                  repo: `${owner}/${repo}`
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error checking discussions for ${owner}/${repo}:`, error.message);
    }
  }
}

// 리뷰 상태에 따른 이모지 반환
function getReviewStateEmoji(state) {
  switch (state) {
    case 'APPROVED': return '✅';
    case 'CHANGES_REQUESTED': return '❌';
    case 'COMMENTED': return '💬';
    default: return '❓';
  }
}

// 텍스트 자르기 함수
function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Discord로 알림 보내기
async function sendDiscordNotification(data) {
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [{
        title: data.title,
        description: data.description,
        url: data.url,
        color: 3447003, // 파란색
        author: {
          name: data.author
        },
        footer: {
          text: `Repository: ${data.repo}`
        },
        timestamp: new Date()
      }]
    });
    console.log('알림 전송 완료:', data.title);
  } catch (error) {
    console.error('Discord 알림 전송 실패:', error.message);
  }
}

// 메인 함수
async function main() {
  try {
    // 각 기능별로 확인 실행
    await checkForReviewRequests();
    await checkForNewReviews();
    await checkForNewIssuesAndComments();
    await checkForNewDiscussions();
    
    console.log('모든 확인 완료');
  } catch (error) {
    console.error('실행 중 오류 발생:', error);
  }
}

// 스크립트 실행
main();
